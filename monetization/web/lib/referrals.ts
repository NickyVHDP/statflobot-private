import { randomInt } from 'crypto';
import { createServiceClient } from './supabase/server';
import { isAdminEmail } from './admin';
import { auditLog } from './license';
import {
  deriveReferralTimeline as deriveTimeline,
  referralStatusDescriptions,
  type ReferralTimelineInput,
  type ReferralTimelineItem,
} from './referralStatus';

/**
 * lib/referrals.ts
 *
 * Lifetime-only referral program core. Every money-affecting rule lives here so
 * the routes stay thin and the invariants are testable in one place.
 *
 * INVARIANTS (each is enforced at more than one layer on purpose):
 *
 *   1. Only a verified LIFETIME customer may hold a code. Admin accounts are
 *      excluded — lib/admin.ts hands them a SYNTHETIC lifetime license that
 *      does not correspond to a purchase, so "has lifetime" alone would let the
 *      owner's own account earn rewards.
 *   2. A code must be applied BEFORE the Checkout Session is created. There is
 *      no code path that attaches a referrer to an existing session, which is
 *      what makes "never retroactive" structural rather than procedural.
 *   3. Only NEW buyers count — no prior paid monthly or lifetime entitlement.
 *   4. Monthly never accrues. Enforced by the route (rejects the field), by
 *      accrueReferral() (checks plan_code), and by a CHECK constraint.
 *   5. The ledger is append-only. Reversals are new negative rows.
 */

// ── Program constants ────────────────────────────────────────────────────────

/** Legacy/base reward and minimum payout threshold. New rewards are tiered. */
export const REFERRAL_ACCRUAL_CENTS = 1000;

export const EARLY_REFERRAL_REWARD_TIERS = [
  { min: 1,  max: 3,        cents: 1000 },
  { min: 4,  max: 5,        cents: 1500 },
  { min: 6,  max: Infinity, cents: 2000 },
] as const;

export const STANDARD_REFERRAL_REWARD_TIERS = [
  { min: 1, max: 3,        cents: 1500 },
  { min: 4, max: 5,        cents: 2000 },
  { min: 6, max: Infinity, cents: 2500 },
] as const;

/** Backward-compatible export: the live summary selects the correct schedule. */
export const REFERRAL_REWARD_TIERS = EARLY_REFERRAL_REWARD_TIERS;

export const REFERRAL_REWARD_CAP_PERCENT = 40;

export function getReferralRewardTiers(planCode: string) {
  return planCode === 'lifetime_standard'
    ? STANDARD_REFERRAL_REWARD_TIERS
    : EARLY_REFERRAL_REWARD_TIERS;
}

export function getRewardTierCents(qualifiedPosition: number, planCode = 'lifetime_early'): number {
  const position = Math.max(1, Math.floor(qualifiedPosition));
  return getReferralRewardTiers(planCode).find((tier) => position >= tier.min && position <= tier.max)!.cents;
}

export function getNextReferralMilestone(netQualifiedCount: number, planCode = 'lifetime_early'): {
  currentRateCents: number;
  nextRateCents: number | null;
  nextUnlockAt: number | null;
  referralsToUnlock: number | null;
} {
  const nextPosition = Math.max(0, Math.floor(netQualifiedCount)) + 1;
  const tiers = getReferralRewardTiers(planCode);
  const currentRateCents = getRewardTierCents(nextPosition, planCode);
  const nextTier = tiers.find((tier) => tier.min > nextPosition);
  return {
    currentRateCents,
    nextRateCents: nextTier?.cents ?? null,
    nextUnlockAt: nextTier?.min ?? null,
    referralsToUnlock: nextTier ? Math.max(0, nextTier.min - nextPosition) : null,
  };
}

/** Chargeback/fraud hold. An accrual is not payable until 30 days after purchase. */
export const REFERRAL_HOLD_DAYS = 30;

/** Current terms version recorded with each lifetime purchase. */
export const TERMS_VERSION = '2026-08-12';

/**
 * How long a "code applied, not yet paid" reservation stays visible to the
 * referrer. Stripe Checkout Sessions expire after 24h, and `checkout.session.
 * expired` settles the row properly — this TTL is only the fallback for when
 * that event never arrives, so a stale entry cannot linger forever.
 */
export const REFERRAL_RESERVATION_TTL_HOURS = 24;

/** Referral codes use an unambiguous alphabet: no I, L, O, U, 0, 1. */
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTVWXYZ23456789';
const CODE_LENGTH = 10;

/**
 * Minimum eligible balance required before a payout may be approved.
 *
 * Owner-set minimum: $10.00. The environment may raise the threshold, but it
 * can never lower it below one earned referral reward.
 */
export function getPayoutThresholdCents(): number | null {
  const raw = process.env.REFERRAL_PAYOUT_THRESHOLD_CENTS;
  if (!raw) return REFERRAL_ACCRUAL_CENTS;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < REFERRAL_ACCRUAL_CENTS) return null;
  return parsed;
}

/**
 * Master switch for actually moving money via Stripe Connect.
 * Defaults CLOSED. The ledger, admin queue and hosted onboarding all work with
 * this off; only `transfers.create` is gated.
 */
export function arePayoutsEnabled(): boolean {
  return process.env.REFERRAL_PAYOUTS_ENABLED === 'true';
}

// ── Code generation ──────────────────────────────────────────────────────────

/**
 * Cryptographically secure referral code.
 *
 * Uses crypto.randomInt, NOT Math.random. generateLicenseKey() in lib/license.ts
 * uses Math.random, which is fine for an opaque server-issued key but not for a
 * value a stranger is invited to guess at against a public validation endpoint.
 */
export function generateReferralCode(): string {
  let out = '';
  for (let i = 0; i < CODE_LENGTH; i++) {
    out += CODE_ALPHABET[randomInt(0, CODE_ALPHABET.length)];
  }
  return out;
}

/**
 * Normalize user-entered codes: case and separators only.
 *
 * Deliberately does NOT remap lookalike characters. The alphabet already
 * excludes every ambiguous glyph (I, L, O, U, 0, 1), so there is no principled
 * target to remap them to — and remapping would be actively dangerous: folding
 * a typed "I" onto "J" could silently resolve to a DIFFERENT referrer's valid
 * code. An out-of-alphabet character means the code is malformed, and malformed
 * codes are rejected.
 */
export function normalizeReferralCode(input: string): string {
  return String(input ?? '')
    .trim()
    .toUpperCase()
    .replace(/[\s-]/g, '');
}

/** True when a normalized code matches the issued-code format exactly. */
export function isWellFormedReferralCode(code: string): boolean {
  return new RegExp(`^[${CODE_ALPHABET}]{${CODE_LENGTH}}$`).test(code);
}

/**
 * Normalized Statflo identity, mirroring app/api/identity/lock/route.ts.
 * Used as a second self-referral signal when both parties have run the bot.
 */
export function normalizeStatfloIdentity(raw: string): string {
  return String(raw || '')
    .trim()
    .toLowerCase()
    .replace(/@cellularsales\.com$/, '');
}

function normalizeEmail(email: string | null | undefined): string {
  return String(email ?? '').trim().toLowerCase();
}

// ── Eligibility ──────────────────────────────────────────────────────────────

/**
 * True when the user holds a REAL active lifetime entitlement.
 *
 * Deliberately queries the licenses/subscriptions tables rather than trusting
 * ADMIN_LICENSE, so an admin bypass account cannot qualify. Mirrors the
 * ownership check in app/api/checkout/lifetime/route.ts.
 */
export async function hasRealLifetimeEntitlement(userId: string): Promise<boolean> {
  const svc = createServiceClient();

  const { data: license } = await svc
    .from('licenses')
    .select('id')
    .eq('user_id', userId)
    .eq('plan', 'lifetime')
    .eq('status', 'active')
    .limit(1)
    .maybeSingle();
  if (license) return true;

  const { data: sub } = await svc
    .from('subscriptions')
    .select('id')
    .eq('user_id', userId)
    .eq('status', 'lifetime')
    .limit(1)
    .maybeSingle();

  return !!sub;
}

/**
 * True when this person has NO prior paid entitlement of any kind.
 *
 * "New user" per the owner's definition: no prior monthly OR lifetime paid
 * purchase. Checked by user id when known and always by email, because the
 * guest purchase-first flow has no account at Checkout time — the email is the
 * only identifier available until reconciliation.
 */
export async function isNewBuyer(opts: {
  userId?: string | null;
  email?: string | null;
}): Promise<{ isNew: boolean; reason?: string }> {
  const svc = createServiceClient();
  const email = normalizeEmail(opts.email);

  let userId = opts.userId ?? null;

  // Resolve the account behind this email, if one exists. auth.users is queried
  // directly rather than `profiles` — profiles is absent from some environments
  // and auth.users is the authoritative identity table in all of them.
  if (!userId && email) {
    try {
      const found = await findUserIdByEmail(email);
      if (found) userId = found;
    } catch (err) {
      // Fail CLOSED. An undecidable identity lookup must never be reported as a
      // brand-new buyer — that is the exact condition that would pay a referral
      // reward on a returning customer. The referral is dropped; the purchase
      // itself is unaffected.
      if (err instanceof ReferralUserLookupError) {
        console.error('[REFERRAL_NEW_BUYER_FAIL_CLOSED]', err.message);
        return { isNew: false, reason: 'user-lookup-unavailable' };
      }
      throw err;
    }
  }

  if (userId) {
    const { data: anyLicense } = await svc
      .from('licenses')
      .select('id, plan, status')
      .eq('user_id', userId)
      .neq('status', 'revoked')
      .limit(1)
      .maybeSingle();
    if (anyLicense) return { isNew: false, reason: 'existing-license' };

    const { data: anySub } = await svc
      .from('subscriptions')
      .select('id, status')
      .eq('user_id', userId)
      .in('status', ['active', 'trialing', 'past_due', 'canceled', 'lifetime'])
      .limit(1)
      .maybeSingle();
    if (anySub) return { isNew: false, reason: 'existing-subscription' };
  }

  if (email) {
    // A guest purchase already reconciled (or awaiting reconciliation) under
    // this email also disqualifies — otherwise buying twice as a guest would
    // read as two separate "new" buyers.
    const { data: priorPending } = await svc
      .from('pending_purchases')
      .select('id')
      .eq('email', email)
      .limit(1)
      .maybeSingle();
    if (priorPending) return { isNew: false, reason: 'existing-purchase' };

    const { data: priorReferred } = await svc
      .from('referral_attributions')
      .select('id')
      .eq('referred_email', email)
      .limit(1)
      .maybeSingle();
    if (priorReferred) return { isNew: false, reason: 'already-referred' };
  }

  return { isNew: true };
}

/**
 * Look up a user id by email via the auth admin API (auth.users, not profiles).
 *
 * `profiles` is deliberately not used: it is absent from some environments,
 * whereas auth.users is the authoritative identity table in all of them.
 *
 * listUsers has no server-side email filter, so this pages through. A single
 * page would silently weaken the new-buyer fraud check the moment the user base
 * outgrew it — the lookup would return null for a real returning customer and
 * they would read as a new buyer. Paging is capped so a pathological account
 * count cannot stall a checkout. Hitting the cap does NOT mean the account is
 * absent, so it throws ReferralUserLookupError instead of returning null; the
 * caller fails closed and the check needs a real index rather than a scan.
 */
const USER_LOOKUP_PAGE_SIZE = 1000;
const USER_LOOKUP_MAX_PAGES = 20; // 20k accounts

/**
 * Raised when the paged scan hits its cap without deciding. Callers MUST treat
 * this as "unknown", never as "no account exists" — see isNewBuyer().
 */
export class ReferralUserLookupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReferralUserLookupError';
  }
}

export async function findUserIdByEmail(email: string): Promise<string | null> {
  const target = normalizeEmail(email);
  if (!target) return null;

  const svc = createServiceClient();
  let exhausted = false;
  try {
    for (let page = 1; page <= USER_LOOKUP_MAX_PAGES; page++) {
      const { data, error } = await svc.auth.admin.listUsers({
        page,
        perPage: USER_LOOKUP_PAGE_SIZE,
      });
      if (error) {
        throw new ReferralUserLookupError(
          `Could not determine whether this email already has an account: ${error.message || 'auth user lookup failed'}`
        );
      }
      if (!data?.users?.length) return null;

      const match = data.users.find((u: any) => normalizeEmail(u.email) === target);
      if (match) return match.id;

      if (data.users.length < USER_LOOKUP_PAGE_SIZE) return null; // last page
    }
    exhausted = true;
  } catch (err) {
    if (err instanceof ReferralUserLookupError) throw err;
    throw new ReferralUserLookupError(
      `Could not determine whether this email already has an account: ${err instanceof Error ? err.message : 'auth user lookup failed'}`
    );
  }

  // Fail CLOSED. Returning null here would have said "no such account", which
  // reads downstream as "new buyer" and would silently pay a referral reward on
  // a returning customer. The scan cap means the answer is unknown, not no.
  if (exhausted) {
    console.error(
      `[REFERRAL_USER_LOOKUP_EXHAUSTED] scanned ${USER_LOOKUP_MAX_PAGES * USER_LOOKUP_PAGE_SIZE} ` +
      `accounts without a match — the new-buyer check needs an indexed email lookup`
    );
    throw new ReferralUserLookupError(
      'Could not determine whether this email already has an account: the user scan cap was reached.'
    );
  }
  return null;
}

/** Fetch a user's email from auth.users. Returns '' when unavailable. */
export async function getUserEmail(userId: string): Promise<string> {
  const svc = createServiceClient();
  try {
    const { data, error } = await svc.auth.admin.getUserById(userId);
    if (error) return '';
    return normalizeEmail(data?.user?.email);
  } catch {
    return '';
  }
}

/** Locked Statflo identities for a user, used as a self-referral signal. */
async function getStatfloIdentities(userId: string): Promise<string[]> {
  const svc = createServiceClient();
  const { data, error } = await svc
    .from('licenses')
    .select('statflo_identity')
    .eq('user_id', userId);

  // Column may be missing in environments that have not run the 2026-05-11
  // migration; treat that as "no signal" rather than failing the checkout.
  if (error) return [];

  return (data ?? [])
    .map((row: any) => normalizeStatfloIdentity(row.statflo_identity ?? ''))
    .filter(Boolean);
}

// ── Validation ───────────────────────────────────────────────────────────────

export interface ReferralValidation {
  valid: boolean;
  /** Machine-readable cause. Never surfaced verbatim to an anonymous caller. */
  reason?:
    | 'not-found'
    | 'disabled'
    | 'referrer-not-lifetime'
    | 'self-referral'
    | 'not-new-user'
    | 'malformed';
  codeId?: string;
  code?: string;
  referrerUserId?: string;
}

/**
 * Full server-side validation of a referral code for a prospective buyer.
 *
 * Runs at Checkout Session creation (authoritative) and again, cheaply, from
 * the pre-checkout validation endpoint so the buyer gets fast feedback.
 */
export async function validateReferralCode(
  rawCode: string,
  buyer: { userId?: string | null; email?: string | null }
): Promise<ReferralValidation> {
  const code = normalizeReferralCode(rawCode);
  if (!isWellFormedReferralCode(code)) return { valid: false, reason: 'malformed' };

  const svc = createServiceClient();
  const { data: row } = await svc
    .from('referral_codes')
    .select('id, code, referrer_user_id, status')
    .eq('code', code)
    .maybeSingle();

  if (!row) return { valid: false, reason: 'not-found' };
  if (row.status !== 'active') return { valid: false, reason: 'disabled', code };

  // The referrer must STILL be a lifetime customer at the moment the code is
  // used. (An attribution already written stays valid regardless — see the
  // frozen-snapshot note in the migration.)
  if (!(await hasRealLifetimeEntitlement(row.referrer_user_id))) {
    return { valid: false, reason: 'referrer-not-lifetime', code };
  }

  // ── Self-referral ────────────────────────────────────────────────────────
  const buyerEmail = normalizeEmail(buyer.email);
  const referrerEmail = await getUserEmail(row.referrer_user_id);

  if (buyer.userId && buyer.userId === row.referrer_user_id) {
    return { valid: false, reason: 'self-referral', code };
  }
  if (buyerEmail && referrerEmail && buyerEmail === referrerEmail) {
    return { valid: false, reason: 'self-referral', code };
  }

  // Same human, different email: compare the Statflo identity lock, which is
  // the strongest "same person" signal the product has.
  if (buyer.userId) {
    const [buyerIds, referrerIds] = await Promise.all([
      getStatfloIdentities(buyer.userId),
      getStatfloIdentities(row.referrer_user_id),
    ]);
    if (buyerIds.some((id) => referrerIds.includes(id))) {
      return { valid: false, reason: 'self-referral', code };
    }
  }

  const newBuyer = await isNewBuyer({ userId: buyer.userId, email: buyer.email });
  if (!newBuyer.isNew) return { valid: false, reason: 'not-new-user', code };

  return {
    valid: true,
    codeId: row.id,
    code: row.code,
    referrerUserId: row.referrer_user_id,
  };
}

// ── Code issuance ────────────────────────────────────────────────────────────

export interface IssueCodeResult {
  ok: boolean;
  code?: string;
  reason?: 'not-lifetime' | 'admin-excluded' | 'disabled' | 'error';
}

/**
 * Return the caller's existing code, or mint one. Idempotent: the unique
 * constraint on referrer_user_id guarantees at most one code per referrer even
 * under concurrent requests.
 */
export async function getOrCreateReferralCode(
  userId: string,
  email: string | null | undefined
): Promise<IssueCodeResult> {
  // The owner/admin account cannot hold a referral code.
  if (isAdminEmail(email)) return { ok: false, reason: 'admin-excluded' };

  const svc = createServiceClient();

  const { data: existing } = await svc
    .from('referral_codes')
    .select('code, status')
    .eq('referrer_user_id', userId)
    .maybeSingle();

  if (existing) {
    if (existing.status !== 'active') return { ok: false, reason: 'disabled' };
    return { ok: true, code: existing.code };
  }

  if (!(await hasRealLifetimeEntitlement(userId))) return { ok: false, reason: 'not-lifetime' };

  // Retry on the astronomically unlikely code collision.
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = generateReferralCode();
    const { data, error } = await svc
      .from('referral_codes')
      .insert({ code, referrer_user_id: userId })
      .select('code')
      .single();

    if (!error && data) {
      await auditLog(userId, 'referral_code_issued', { code });
      return { ok: true, code: data.code };
    }

    // 23505 = unique violation. On referrer_user_id it means a concurrent
    // request won the race — return that code rather than erroring.
    if (error?.code === '23505') {
      const { data: raced } = await svc
        .from('referral_codes')
        .select('code, status')
        .eq('referrer_user_id', userId)
        .maybeSingle();
      if (raced) {
        return raced.status === 'active'
          ? { ok: true, code: raced.code }
          : { ok: false, reason: 'disabled' };
      }
      continue; // collision was on `code` — try another
    }

    console.error('[referrals] code insert failed', error?.code, error?.message);
    return { ok: false, reason: 'error' };
  }

  return { ok: false, reason: 'error' };
}

// ── Attribution + accrual ────────────────────────────────────────────────────

export interface AccrualInput {
  stripeSessionId: string;
  stripePaymentIntentId?: string | null;
  referrerUserId: string;
  referralCodeId: string;
  referralCode: string;
  referredUserId?: string | null;
  referredEmail: string;
  planCode: string;
  termsVersion?: string | null;
  termsAcceptedAt?: string | null;
  stripeEventId?: string | null;
  /** Total actually charged by Stripe, including any tax. */
  saleAmountCents: number;
  /** Net product revenue after discounts, excluding tax and shipping. */
  rewardBasisCents: number;
  currency: string;
  purchasedAt?: string | null;
}

/**
 * Write the attribution and its accrual for a COMPLETED, PAID lifetime purchase.
 *
 * Called from the webhook (logged-in path) and from reconcilePendingPurchase
 * (guest path). Idempotent by construction:
 *   - referral_attributions.stripe_session_id is unique
 *   - uniq_referral_ledger_accrual allows one accrual per attribution
 *
 * Callers must only invoke this AFTER the license has been provisioned, so a
 * reward can never exist for a purchase that failed to grant access.
 */
export async function accrueReferral(input: AccrualInput): Promise<{
  accrued: boolean;
  reason?: string;
  rewardCents?: number;
  qualifiedPosition?: number;
  lifetimeSequence?: number;
}> {
  const svc = createServiceClient();

  // Layer 4 of the monthly exclusion (route, caller, here, CHECK constraint).
  if (!['lifetime_early', 'lifetime_standard'].includes(input.planCode)) {
    console.warn(`[REFERRAL_ACCRUAL_SKIPPED] reason=not-lifetime planCode=${input.planCode}`);
    return { accrued: false, reason: 'not-lifetime' };
  }

  if (input.referrerUserId === input.referredUserId) {
    console.warn(`[REFERRAL_ACCRUAL_SKIPPED] reason=self-referral session=${input.stripeSessionId}`);
    return { accrued: false, reason: 'self-referral' };
  }

  if (input.currency?.toLowerCase() !== 'usd') {
    console.warn(`[REFERRAL_ACCRUAL_SKIPPED] reason=unsupported-currency currency=${input.currency}`);
    return { accrued: false, reason: 'unsupported-currency' };
  }

  if (!Number.isInteger(input.saleAmountCents) || !Number.isInteger(input.rewardBasisCents) ||
      input.saleAmountCents <= 0 || input.rewardBasisCents <= 0 ||
      input.rewardBasisCents > input.saleAmountCents) {
    throw new Error('Referral purchase amount snapshot is invalid.');
  }

  // NOTE ON THE "NEW BUYER" GATE — it is deliberately NOT re-run here.
  //
  // By the time this runs the license has already been provisioned, so the
  // buyer now HAS an entitlement and isNewBuyer() would return false for every
  // legitimate referral. The gate must therefore run at the last moment before
  // any purchase artifact exists, and its result is frozen for this session:
  //
  //   logged-in buyer → app/api/checkout/lifetime (Session creation)
  //   guest buyer     → the webhook, on checkout.session.completed, BEFORE the
  //                     pending_purchases row is written (first moment the
  //                     buyer's email is knowable)
  //
  // Callers are responsible for having passed that gate.
  const purchasedAt = input.purchasedAt ?? new Date().toISOString();
  const eligibleAt = new Date(
    new Date(purchasedAt).getTime() + REFERRAL_HOLD_DAYS * 86_400_000
  ).toISOString();

  // Attribution, serialized tier assignment and ledger accrual are one DB
  // transaction. Never replace this RPC with application count-then-insert.
  const { data, error } = await svc.rpc('accrue_tiered_referral', {
    p_stripe_session_id:        input.stripeSessionId,
    p_stripe_payment_intent_id: input.stripePaymentIntentId ?? null,
    p_referral_code_id:         input.referralCodeId,
    p_referral_code:            input.referralCode,
    p_referrer_user_id:         input.referrerUserId,
    p_referred_user_id:         input.referredUserId ?? null,
    p_referred_email:           normalizeEmail(input.referredEmail),
    p_plan_code:                input.planCode,
    p_terms_version:            input.termsVersion ?? null,
    p_terms_accepted_at:        input.termsAcceptedAt ?? null,
    p_stripe_event_id:          input.stripeEventId ?? null,
    p_sale_amount_cents:        input.saleAmountCents,
    p_reward_basis_cents:       input.rewardBasisCents,
    p_currency:                 input.currency.toLowerCase(),
    p_purchased_at:             purchasedAt,
    p_eligible_at:              eligibleAt,
  });

  if (error) {
    console.error('[REFERRAL_ATOMIC_ACCRUAL_FAILED]', error.code, error.message);
    throw new Error(`Atomic referral accrual failed: ${error.message}`);
  }

  const result = Array.isArray(data) ? data[0] : data;
  if (!result?.created) {
    console.log(`[REFERRAL_ACCRUAL_DUPLICATE_IGNORED] session=${input.stripeSessionId}`);
    return {
      accrued: false,
      reason: 'duplicate',
      rewardCents: result?.reward_cents,
      qualifiedPosition: result?.qualified_position,
      lifetimeSequence: result?.lifetime_sequence,
    };
  }

  console.log(
    `[REFERRAL_ACCRUED] session=${input.stripeSessionId} referrer=${input.referrerUserId} ` +
    `amount=${result.reward_cents} qualifiedPosition=${result.qualified_position} ` +
    `sequence=${result.lifetime_sequence} eligibleAt=${eligibleAt}`
  );
  await auditLog(input.referrerUserId, 'referral_accrued', {
    stripe_session_id: input.stripeSessionId,
    amount_cents:      result.reward_cents,
    reward_tier_cents: result.reward_tier_cents,
    qualified_position: result.qualified_position,
    lifetime_sequence: result.lifetime_sequence,
    sale_amount_cents: input.saleAmountCents,
    reward_basis_cents: input.rewardBasisCents,
    eligible_at:       eligibleAt,
    referred_email:    normalizeEmail(input.referredEmail),
  });

  return {
    accrued: true,
    rewardCents: result.reward_cents,
    qualifiedPosition: result.qualified_position,
    lifetimeSequence: result.lifetime_sequence,
  };
}

/**
 * Reverse the accrual for a refunded or disputed referred purchase.
 *
 * Append-only: writes a negative row and never touches the accrual. Idempotent
 * via uniq_referral_ledger_reversal, so a refund followed by a dispute on the
 * same charge debits the referrer exactly once.
 *
 * If the accrual was already paid out, this legitimately drives the balance
 * negative — the debt offsets future rewards and is flagged in the admin UI.
 */
export async function reverseReferralForCharge(opts: {
  paymentIntentId?: string | null;
  stripeSessionId?: string | null;
  stripeEventId: string;
  cause: 'refund' | 'dispute';
}): Promise<{ reversed: boolean; reason?: string }> {
  const svc = createServiceClient();
  if (!opts.paymentIntentId && !opts.stripeSessionId) {
    return { reversed: false, reason: 'no-identifier' };
  }

  const { data, error } = await svc.rpc('reverse_tiered_referral', {
    p_stripe_payment_intent_id: opts.paymentIntentId ?? null,
    p_stripe_session_id:        opts.stripeSessionId ?? null,
    p_stripe_event_id:          opts.stripeEventId,
    p_cause:                    opts.cause,
  });

  if (error) {
    console.error('[REFERRAL_REVERSAL_FAILED]', error.code, error.message);
    return { reversed: false, reason: 'ledger-failed' };
  }

  const result = Array.isArray(data) ? data[0] : data;
  if (!result) return { reversed: false, reason: 'no-attribution' };
  if (!result.reversed) {
    console.log(`[REFERRAL_REVERSAL_DUPLICATE_IGNORED] attribution=${result.attribution_id}`);
    return { reversed: false, reason: 'duplicate' };
  }

  const reversalCents = result.amount_cents;

  console.warn(
    `[REFERRAL_REVERSED] cause=${opts.cause} attribution=${result.attribution_id} ` +
    `referrer=${result.referrer_user_id} amount=${reversalCents}`
  );
  await auditLog(result.referrer_user_id, 'referral_reversed', {
    attribution_id:    result.attribution_id,
    stripe_session_id: result.stripe_session_id,
    cause:             opts.cause,
    amount_cents:      reversalCents,
  });

  return { reversed: true };
}

// ── Balances ─────────────────────────────────────────────────────────────────

export interface ReferralBalance {
  /** Accrued but still inside the 30-day hold. */
  pendingCents: number;
  /** Past the hold and not yet paid — the only money a payout may draw on. */
  eligibleCents: number;
  /** Lifetime total paid out (positive number). */
  paidCents: number;
  /** Submitted to Stripe but not posted yet. */
  processingCents: number;
  /** Lifetime total reversed by refund/chargeback (positive number). */
  reversedCents: number;
  /** True when reversals after payout have left the referrer in debt. */
  isNegative: boolean;
  referredCount: number;
  /** All completed attributed purchases, including later reversals. */
  lifetimeReferredCount: number;
}

/**
 * Compute balances from the append-only ledger. There is no cached balance
 * column anywhere — SUM over the ledger is the single source of truth.
 */
export async function getReferralBalance(userId: string): Promise<ReferralBalance> {
  const svc = createServiceClient();
  const now = Date.now();

  const { data: entries } = await svc
    .from('referral_ledger')
    .select('entry_type, amount_cents, eligible_at, attribution_id, payout_id')
    .eq('referrer_user_id', userId);

  let pending = 0;
  let eligible = 0;
  let paid = 0;
  let processing = 0;
  let reversed = 0;
  const reversedAttributions = new Set<string>();

  for (const e of entries ?? []) {
    if (e.entry_type === 'reversal' && e.attribution_id) reversedAttributions.add(e.attribution_id);
  }

  // A reversed accrual is handled as a PAIR, and the pair is either both
  // counted or both skipped. Counting one without the other double-debits:
  // skipping the accrual already nets the money out, so also applying the
  // reversal would charge the referrer twice for one refund.
  //
  //   reversed while still held   → skip both. The money never became
  //                                 spendable, so there is nothing to claw back
  //                                 and nothing to show as "pending".
  //   reversed after maturing     → count both. The +accrual and −reversal
  //                                 cancel to zero, and if a payout already
  //                                 drew on that accrual the remaining −payout
  //                                 correctly leaves the referrer in debt.
  const accrualByAttribution = new Map<string, any>();
  for (const e of entries ?? []) {
    if (e.entry_type === 'accrual' && e.attribution_id) {
      accrualByAttribution.set(e.attribution_id, e);
    }
  }

  const matured = (entry: any) => new Date(entry.eligible_at).getTime() <= now;

  for (const e of entries ?? []) {
    if (e.entry_type === 'accrual') {
      const isReversed = reversedAttributions.has(e.attribution_id!);
      if (isReversed && !matured(e)) continue;   // pair skipped
      if (matured(e)) eligible += e.amount_cents;
      else pending += e.amount_cents;
      continue;
    }

    if (e.entry_type === 'reversal') {
      reversed += Math.abs(e.amount_cents);
      const accrual = e.attribution_id ? accrualByAttribution.get(e.attribution_id) : null;
      if (accrual && !matured(accrual)) continue; // pair skipped
      eligible += e.amount_cents;                 // negative
      continue;
    }

    if (e.entry_type === 'payout') {
      eligible += e.amount_cents; // negative
    }
  }

  const { data: payoutRows } = await svc
    .from('referral_payouts')
    .select('amount_cents, status')
    .eq('referrer_user_id', userId)
    .in('status', ['processing', 'paid']);
  for (const payout of payoutRows ?? []) {
    if (payout.status === 'paid') paid += payout.amount_cents;
    if (payout.status === 'processing') processing += payout.amount_cents;
  }

  const { count: lifetimeReferredCount } = await svc
    .from('referral_attributions')
    .select('*', { count: 'exact', head: true })
    .eq('referrer_user_id', userId);

  return {
    pendingCents:  pending,
    eligibleCents: eligible,
    paidCents:     paid,
    processingCents: processing,
    reversedCents: reversed,
    isNegative:    eligible < 0,
    referredCount: Math.max(0, accrualByAttribution.size - reversedAttributions.size),
    lifetimeReferredCount: lifetimeReferredCount ?? 0,
  };
}

// ── Reservations: "someone applied your code" ────────────────────────────────

/**
 * Record that a valid code was applied to a lifetime Checkout Session.
 *
 * NOT MONEY. This exists so the referrer sees a pending entry the moment a new
 * buyer applies their code, rather than silence until the payment lands. No
 * balance anywhere reads this table.
 *
 * BEST EFFORT BY DESIGN: a failure here must never block a checkout. The buyer
 * paying is what matters; the referrer's preview of it is not. The accrual path
 * is entirely independent — it keys off Stripe session metadata, not this row —
 * so a lost reservation costs a moment of visibility and nothing else.
 */
export async function reserveReferral(input: {
  stripeSessionId: string;
  referralCodeId: string;
  referralCode: string;
  referrerUserId: string;
  referredEmail?: string | null;
  planCode: string;
}): Promise<{ reserved: boolean; reason?: string }> {
  if (!['lifetime_early', 'lifetime_standard'].includes(input.planCode)) {
    return { reserved: false, reason: 'not-lifetime' };
  }

  const svc = createServiceClient();
  const expiresAt = new Date(
    Date.now() + REFERRAL_RESERVATION_TTL_HOURS * 3_600_000
  ).toISOString();

  const { error } = await svc.from('referral_reservations').insert({
    stripe_session_id: input.stripeSessionId,
    referral_code_id:  input.referralCodeId,
    referral_code:     input.referralCode,
    referrer_user_id:  input.referrerUserId,
    referred_email:    input.referredEmail ? normalizeEmail(input.referredEmail) : null,
    plan_code:         input.planCode,
    expires_at:        expiresAt,
  });

  if (error) {
    // 23505 → the session already has a reservation (a retried request).
    if (error.code === '23505') return { reserved: false, reason: 'duplicate' };
    console.warn('[REFERRAL_RESERVATION_FAILED]', error.code, error.message);
    return { reserved: false, reason: 'error' };
  }

  console.log(
    `[REFERRAL_RESERVED] session=${input.stripeSessionId} referrer=${input.referrerUserId} ` +
    `expiresAt=${expiresAt}`
  );
  return { reserved: true };
}

/**
 * Settle a reservation once the session's outcome is known.
 *
 * Only ever moves a row OUT of 'reserved', so a replayed webhook cannot revive
 * a settled reservation or flip 'converted' back to 'expired'.
 */
export async function settleReservation(
  stripeSessionId: string,
  status: 'converted' | 'expired' | 'canceled'
): Promise<void> {
  const svc = createServiceClient();
  const { error } = await svc
    .from('referral_reservations')
    .update({ status, settled_at: new Date().toISOString() })
    .eq('stripe_session_id', stripeSessionId)
    .eq('status', 'reserved');

  if (error) {
    console.warn('[REFERRAL_RESERVATION_SETTLE_FAILED]', error.code, error.message);
    return;
  }
  console.log(`[REFERRAL_RESERVATION_SETTLED] session=${stripeSessionId} status=${status}`);
}

// ── User-facing status vocabulary ────────────────────────────────────────────
//
// The vocabulary and the state machine live in lib/referralStatus.ts, which has
// no imports at all so the tests can exercise the real function instead of a
// re-implementation. Re-exported here so callers keep a single entry point.

export type { ReferralStatus, ReferralTimelineItem } from './referralStatus';
export { REFERRAL_STATUS_LABELS } from './referralStatus';

/** Status explanations, bound to this program's configured hold. */
export const REFERRAL_STATUS_DESCRIPTIONS = referralStatusDescriptions(REFERRAL_HOLD_DAYS);

/**
 * Per-referral status list for a referrer, with this program's reward amount
 * applied. See deriveTimeline() in lib/referralStatus.ts for the rules.
 */
export function deriveReferralTimeline(input: ReferralTimelineInput): ReferralTimelineItem[] {
  return deriveTimeline(input);
}
