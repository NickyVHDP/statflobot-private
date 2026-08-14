/**
 * tests/referrals.test.js
 *
 * Lifetime-only referral program.
 *
 * These are structural/static tests in the style of the existing suites
 * (paid-only.test.js, web-security-upgrade.test.js): they assert on the source
 * of the money-handling paths rather than booting Next.js and Stripe. That is
 * a deliberate limit — they prove the guard rails EXIST and are wired in the
 * right order; they do not prove Stripe's runtime behaviour. End-to-end
 * verification against Stripe test mode is still required before enabling
 * payouts, and is listed in the handover notes.
 *
 * Pure logic that can be exercised directly (code format, ledger arithmetic)
 * is tested for real.
 */

const { test } = require('node:test');
const assert   = require('node:assert');
const fs       = require('node:fs');
const path     = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

/**
 * Source with comments removed.
 *
 * Several assertions below check that a file does NOT contain a phrase. Prose
 * explaining *why* a thing is absent ("there is no automatic transfer") would
 * otherwise trip them, so those checks run against code only.
 */
const readCode = (p) =>
  read(p)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, '');

const REFERRALS_LIB   = 'monetization/web/lib/referrals.ts';
const PAYOUTS_LIB     = 'monetization/web/lib/referralPayouts.ts';
const WEBHOOK         = 'monetization/web/app/api/webhooks/stripe/route.ts';
const CHECKOUT_LIFE   = 'monetization/web/app/api/checkout/lifetime/route.ts';
const CHECKOUT_MONTH  = 'monetization/web/app/api/checkout/monthly/route.ts';
const LICENSE_LIB     = 'monetization/web/lib/license.ts';
const MIGRATION       = 'monetization/supabase/add_referrals.sql';
const TIER_MIGRATION  = 'supabase/migrations/20260812211500_tiered_referral_rewards.sql';
const PAYOUT_MIGRATION = 'supabase/migrations/20260813100000_global_referral_payouts.sql';
const RETURNED_PAYOUT_MIGRATION = 'supabase/migrations/20260813143000_restore_returned_global_payouts.sql';
const GLOBAL_PAYOUTS  = 'monetization/web/lib/stripeGlobalPayouts.ts';
const TERMS           = 'monetization/web/app/terms/page.tsx';
const PRICING_CARD    = 'monetization/web/components/PricingCard.tsx';
const CLOUD_API       = 'ui/client/src/lib/cloudApi.js';
const DESKTOP_DIALOG  = 'ui/client/src/components/LifetimePurchaseDialog.jsx';
const ADMIN_PAYOUT    = 'monetization/web/app/api/admin/referrals/payout/route.ts';
const ADMIN_AUDIT     = 'monetization/web/app/api/admin/referrals/route.ts';
const ADMIN_PAGE      = 'monetization/web/app/admin/page.tsx';
const ADMIN_LIB       = 'monetization/web/lib/admin.ts';
const PROXY           = 'ui/server/index.js';
const SUMMARY         = 'monetization/web/app/api/referrals/summary/route.ts';
const WEB_PANEL       = 'monetization/web/components/ReferralPanel.tsx';
const DESKTOP_PANEL   = 'ui/client/src/components/ReferralPanel.jsx';
const DESKTOP_ADMIN_REFERRALS = 'ui/client/src/components/AdminReferralsOverview.jsx';
const DESKTOP_ADMIN_PANEL = 'ui/client/src/components/AdminPanel.jsx';
const LANDING_PAGE = 'monetization/web/app/page.tsx';
const AUTO_PAYOUTS = 'monetization/web/lib/referralAutoPayouts.ts';
const AUTO_PAYOUT_ROUTE = 'monetization/web/app/api/cron/referral-payouts/route.ts';
const AUTO_PAYOUT_MIGRATION = 'supabase/migrations/20260813220000_automatic_referral_payout_runs.sql';
const VERCEL_CONFIG = 'monetization/web/vercel.json';

// ── Eligibility: only real lifetime customers, never admins ──────────────────

test('referral codes require a REAL lifetime entitlement, not the admin synthetic license', () => {
  const src = read(REFERRALS_LIB);

  // Must query the actual tables...
  assert.match(src, /from\('licenses'\)[\s\S]{0,200}eq\('plan',\s*'lifetime'\)/);
  assert.match(src, /eq\('status',\s*'active'\)/);

  // ...and must NOT import or evaluate the synthetic ADMIN_LICENSE object.
  // (The identifier appears in a comment explaining exactly this, so the check
  // targets real usage: an import or a value reference.)
  assert.doesNotMatch(src, /import\s*\{[^}]*ADMIN_LICENSE/,
    'eligibility must never be derived from the synthetic admin license');
  assert.doesNotMatch(src, /ADMIN_LICENSE\s*[.=)\[]/,
    'ADMIN_LICENSE must not be evaluated in eligibility logic');
});

test('admin/owner accounts are excluded from holding a referral code', () => {
  const src = read(REFERRALS_LIB);
  assert.match(src, /isAdminEmail\(email\)/);
  assert.match(src, /reason:\s*'admin-excluded'/);
});

test('lifetime members keep the private Rewards Hub while owners get a read-only app overview', () => {
  const account = read('ui/client/src/screens/AccountScreen.jsx');
  const adminOverview = read(DESKTOP_ADMIN_REFERRALS);
  const adminPanel = read(DESKTOP_ADMIN_PANEL);
  const proxy = read(PROXY);
  const cloud = read(CLOUD_API);

  assert.match(account, /<ReferralPanel isLifetime=\{isLifetime && licStatus === 'active'\} isAdmin=\{isAdmin\}/);
  assert.match(read(DESKTOP_PANEL), /if \(!isLifetime \|\| isAdmin\) return null/);
  assert.match(adminPanel, /<AdminReferralsOverview onLoaded=\{onReferralsLoaded\} refreshToken=\{refreshToken\} \/>/);
  assert.match(proxy, /api\/proxy\/admin\/referrals[\s\S]*api\/admin\/referrals/);
  assert.match(cloud, /fetchAdminReferrals[\s\S]*api\/proxy\/admin\/referrals/);
  assert.match(proxy, /api\/admin\/referrals\?view=overview/,
    'the desktop must request the narrowed owner overview');
  assert.match(read(ADMIN_AUDIT), /view.*overview[\s\S]*NextResponse\.json\(\{ config, queue \}\)/,
    'the desktop response must omit raw attribution, buyer, ledger and approval history');
  assert.match(adminOverview, /read-only/i);
  assert.match(adminOverview, /cannot approve or send payouts/i);
  assert.doesNotMatch(adminOverview, /referred_email|referred_user_id|referred customer/i,
    'the desktop overview must not reveal referred-customer identity');
  assert.doesNotMatch(adminOverview, /act\(['"]approve|executeApprovedPayout|api\/admin\/referrals\/payout/,
    'payout approval must remain absent from the desktop app');
});

test('the public site professionally explains Lifetime Referral Rewards', () => {
  const page = read(LANDING_PAGE);
  assert.match(page, /Lifetime Referral Rewards/);
  assert.match(page, /exact active rate and next milestone/);
  assert.match(page, /30-day hold and automatic bank deposit/i);
  assert.match(page, /Lifetime Referral Rewards included/);
  assert.match(page, /How does the Lifetime referral program work\?/);
  assert.match(page, /href="\/terms"|Referral Program terms/);
});

test('exactly one code per referrer is enforced by a DB constraint, not app logic alone', () => {
  const sql = read(MIGRATION);
  assert.match(sql, /referrer_user_id\s+uuid\s+not null\s+unique/,
    'referral_codes.referrer_user_id must be UNIQUE');
});

// ── Lifetime-only: monthly can never accrue ──────────────────────────────────

test('the monthly checkout route rejects referral codes outright', () => {
  const src = read(CHECKOUT_MONTH);
  assert.match(src, /requestBody\?\.referralCode/);
  assert.match(src, /referral-lifetime-only/);
  assert.match(src, /status:\s*400/);
});

test('accrual refuses any non-lifetime plan code', () => {
  const src = read(REFERRALS_LIB);
  assert.match(src, /\['lifetime_early', 'lifetime_standard'\]\.includes\(input\.planCode\)/);
  assert.match(src, /reason:\s*'not-lifetime'/);
});

test('the database rejects a non-lifetime attribution row', () => {
  const sql = read(TIER_MIGRATION);
  assert.match(sql, /constraint referral_attributions_lifetime_only\s+check \(plan_code in \('lifetime_early', 'lifetime_standard'\)\)/);
});

test('the webhook only accrues on mode=payment lifetime purchases', () => {
  const src = read(WEBHOOK);
  const block = src.slice(src.indexOf('Referral accrual'));
  assert.match(block, /session\.mode === 'payment'/);
  assert.match(block, /licensePlan === 'lifetime'/);
});

test('an unpaid completed Checkout Session cannot provision access or accrue a reward', () => {
  const src = read(WEBHOOK);
  const unpaidAt = src.indexOf("session.payment_status !== 'paid'");
  const provisionAt = src.indexOf('await provisionLicense(');
  assert.ok(unpaidAt > 0 && provisionAt > unpaidAt,
    'the paid-funds gate must run before lifetime provisioning');
  assert.match(src, /UNPAID_LIFETIME_CHECKOUT_IGNORED/);
});

// ── Never retroactive ────────────────────────────────────────────────────────

test('the referrer is resolved and frozen at Checkout Session creation', () => {
  const src = read(CHECKOUT_LIFE);
  assert.match(src, /validateReferralCode\(/);
  assert.match(src, /referrer_user_id:\s*referral\.referrerUserId/);
  // Frozen into BOTH metadata carriers.
  const metaCount = (src.match(/\.\.\.referralMetadata/g) ?? []).length;
  assert.ok(metaCount >= 4,
    `referral metadata must be attached to session + payment_intent metadata on both the logged-in and guest paths (found ${metaCount})`);
});

test('no code path attaches a referrer to an already-created session', () => {
  // The application can only call the atomic RPC. The sole INSERT lives inside
  // that database transaction and remains keyed to the frozen Stripe session.
  const lib = read(REFERRALS_LIB);
  assert.match(lib, /rpc\('accrue_tiered_referral'/);
  assert.doesNotMatch(lib, /from\('referral_attributions'\)\s*\n?\s*\.insert/);
  const sql = read(TIER_MIGRATION);
  const writers = (sql.match(/insert into referral_attributions/g) ?? []).length;
  assert.strictEqual(writers, 1, 'exactly one atomic insert path into referral_attributions');

  for (const file of [WEBHOOK, LICENSE_LIB, ADMIN_PAYOUT, ADMIN_AUDIT]) {
    assert.doesNotMatch(read(file), /from\('referral_attributions'\)[\s\S]{0,80}\.insert/,
      `${file} must not insert attributions directly`);
  }
});

// ── New-buyer gate ───────────────────────────────────────────────────────────

test('new-buyer means no prior monthly OR lifetime entitlement', () => {
  const src = read(REFERRALS_LIB);
  const fn = src.slice(src.indexOf('export async function isNewBuyer'));
  assert.match(fn, /from\('licenses'\)/);
  assert.match(fn, /from\('subscriptions'\)/);
  assert.match(fn, /from\('pending_purchases'\)/);
  assert.match(fn, /already-referred/);
});

test('the guest new-buyer check runs before any purchase artifact is written', () => {
  const src = read(WEBHOOK);
  const guestBlock = src.slice(
    src.indexOf('Guest referral snapshot'),
    src.indexOf("from('pending_purchases').upsert")
  );
  assert.match(guestBlock, /await isNewBuyer\(\{ email: pendingEmail \}\)/,
    'the gate must run before the pending_purchases row exists');
});

test('accrual does NOT re-run the new-buyer gate (a license exists by then)', () => {
  const src = read(REFERRALS_LIB);
  const fn = src.slice(src.indexOf('export async function accrueReferral'));
  assert.doesNotMatch(fn, /await isNewBuyer\(/,
    'accrueReferral must not re-check new-buyer — provisioning has already happened');
});

// ── Self-referral ────────────────────────────────────────────────────────────

test('self-referral is blocked by user id, email, and Statflo identity', () => {
  const src = read(REFERRALS_LIB);
  const fn = src.slice(src.indexOf('export async function validateReferralCode'));
  assert.match(fn, /buyer\.userId === row\.referrer_user_id/);
  assert.match(fn, /buyerEmail === referrerEmail/);
  assert.match(fn, /getStatfloIdentities/);
  assert.match(fn, /reason:\s*'self-referral'/);
});

test('accrual independently refuses a self-referral', () => {
  const src = read(REFERRALS_LIB);
  const fn = src.slice(src.indexOf('export async function accrueReferral'));
  assert.match(fn, /input\.referrerUserId === input\.referredUserId/);
});

// ── Guest reconcile ──────────────────────────────────────────────────────────

test('guest purchase-first reconciliation accrues exactly once', () => {
  const src = read(LICENSE_LIB);
  const fn = src.slice(src.indexOf('Guest referral accrual'));

  assert.match(fn, /accrueReferral\(/);
  assert.match(fn, /stripeSessionId:\s*row\.stripe_session_id/,
    'must key on the session id so repeated reconciles collapse to one accrual');
  assert.match(fn, /referredUserId:\s*userId/, 'must backfill the referred user');

  // Ordering: accrual comes AFTER provisionLicense.
  const provisionAt = src.indexOf('await provisionLicense(userId, licensePlan)');
  const accrualAt   = src.indexOf('accrueReferral(');
  assert.ok(provisionAt > 0 && accrualAt > provisionAt,
    'accrual must run after the license is provisioned');
});

test('the guest referral snapshot is carried through pending_purchases metadata', () => {
  const src = read(WEBHOOK);
  assert.match(src, /guestReferral\.referrer_user_id\s*=\s*session\.metadata\.referrer_user_id/);
  assert.match(src, /\.\.\.guestReferral/);
  assert.match(src, /payment_intent:/, 'payment intent must ride through for later reversal matching');
});

// ── Idempotency ──────────────────────────────────────────────────────────────

test('every webhook event claims a stripe_events row before dispatch', () => {
  const src = read(WEBHOOK);
  const claimAt  = src.indexOf("from('stripe_events')");
  const switchAt = src.indexOf('switch (event.type)');
  assert.ok(claimAt > 0 && claimAt < switchAt,
    'the idempotency claim must precede event dispatch');
  assert.match(src, /claimErr\.code === '23505'/);
  assert.match(src, /duplicate:\s*true/);
});

test('a failed handler releases the claim and returns 500 so Stripe retries', () => {
  const src = read(WEBHOOK);
  const catchBlock = src.slice(src.lastIndexOf('} catch (err: any) {'));
  assert.match(catchBlock, /from\('stripe_events'\)\s*\.delete\(\)/,
    'the claim must be released or the retry would short-circuit as a duplicate');
  assert.match(catchBlock, /status:\s*500/);

  // The old unconditional-200 behaviour must be gone.
  assert.doesNotMatch(src, /Return 200 so Stripe doesn't retry/);
});

test('one accrual and one reversal per attribution are enforced by unique indexes', () => {
  const sql = read(MIGRATION);
  assert.match(sql, /unique index if not exists uniq_referral_ledger_accrual[\s\S]{0,120}where entry_type = 'accrual'/);
  assert.match(sql, /unique index if not exists uniq_referral_ledger_reversal[\s\S]{0,120}where entry_type = 'reversal'/);
  assert.match(sql, /stripe_session_id\s+text\s+not null unique/);
});

test('duplicate-key results are swallowed as no-ops, not surfaced as failures', () => {
  const src = read(REFERRALS_LIB);
  assert.match(src, /!result\?\.created[\s\S]{0,300}reason:\s*'duplicate'/);
  assert.match(src, /!result\.reversed[\s\S]{0,300}reason:\s*'duplicate'/);
});

// ── 30-day hold ──────────────────────────────────────────────────────────────

test('the hold is 30 days and the first reward tier starts at $10.00', () => {
  const src = read(REFERRALS_LIB);
  assert.match(src, /REFERRAL_ACCRUAL_CENTS\s*=\s*1000\b/);
  assert.match(src, /REFERRAL_HOLD_DAYS\s*=\s*30\b/);
  assert.match(src, /REFERRAL_HOLD_DAYS \* 86_400_000/);
});

test('price-aware tier assignment is atomic, immutable, reversal-aware, and capped at 40 percent', () => {
  const sql = read(TIER_MIGRATION);
  assert.match(sql, /create or replace function accrue_tiered_referral/);
  assert.match(sql, /from referral_codes[\s\S]{0,180}for update/,
    'concurrent purchases must serialize on the referrer code row');
  assert.match(sql, /lifetime_sequence[\s\S]{0,120}qualified_position/);
  assert.match(sql, /not exists[\s\S]{0,180}entry_type = 'reversal'/,
    'future tier position must use net qualified referrals');
  assert.match(sql, /p_plan_code = 'lifetime_standard' and v_qualified_position <= 3 then 1500/);
  assert.match(sql, /p_plan_code = 'lifetime_standard' and v_qualified_position <= 5 then 2000/);
  assert.match(sql, /p_plan_code = 'lifetime_standard' then 2500/);
  assert.match(sql, /when v_qualified_position <= 3 then 1000/);
  assert.match(sql, /when v_qualified_position <= 5 then 1500/);
  assert.match(sql, /else 2000/);
  assert.match(sql, /floor\(p_reward_basis_cents \* 0\.40\)/);
  assert.match(sql, /least\(v_reward_tier_cents, v_cap_cents\)/);
  assert.match(sql, /unique index if not exists uniq_referral_attribution_lifetime_sequence/);
  assert.match(sql, /create or replace function reverse_tiered_referral[\s\S]*?from referral_codes[\s\S]{0,120}for update/,
    'refunds and new purchases must share the same per-referrer mutex');
});

test('out-of-order refunds are remembered and serialized with later accruals', () => {
  const sql = read(TIER_MIGRATION);
  assert.match(sql, /create table if not exists referral_reversal_intents/,
    'a refund arriving before checkout completion must not be forgotten');
  assert.match(sql, /stripe_event_id\s+text\s+not null unique/,
    'replayed reversal events must remain idempotent');
  const sharedPaymentLock = /pg_advisory_xact_lock\(hashtextextended\([\s\S]{0,180}referral-payment:/g;
  assert.strictEqual((sql.match(sharedPaymentLock) ?? []).length, 2,
    'accrual and reversal must share the same payment mutex');
  assert.match(sql, /from referral_reversal_intents[\s\S]{0,900}entry_type, amount_cents[\s\S]{0,300}'reversal', -v_reward_cents/,
    'a later accrual must immediately neutralize a prior reversal intent');
  assert.match(sql, /update referral_reversal_intents[\s\S]{0,120}applied_at/,
    'processed intents must be marked applied for an auditable lifecycle');
  assert.match(sql, /alter table referral_reversal_intents enable row level security/);
  assert.match(sql, /on referral_reversal_intents for all to service_role/);
  assert.match(sql, /revoke all on function accrue_tiered_referral[\s\S]*from public, anon, authenticated/);
  assert.match(sql, /revoke all on function reverse_tiered_referral[\s\S]*from public, anon, authenticated/);
});

test('one buyer can reward at most one referrer even when two Checkout Sessions race', () => {
  const sql = read(TIER_MIGRATION);
  assert.match(sql, /referral-buyer:/,
    'concurrent sessions for one normalized buyer must share a database mutex');
  assert.match(sql, /unique index if not exists uniq_referral_attribution_referred_email/);
  assert.match(sql, /unique index if not exists uniq_referral_attribution_referred_user/);
  assert.match(sql, /unique index if not exists uniq_referral_attribution_payment_intent/);
  assert.match(sql, /lower\(ra\.referred_email\) = lower\(btrim\(p_referred_email\)\)/);
});

test('the database independently blocks owner email and shared Statflo identity self-referrals', () => {
  const sql = read(TIER_MIGRATION);
  assert.match(sql, /from auth\.users[\s\S]{0,220}self-referral email is not allowed/);
  assert.match(sql, /join licenses referrer[\s\S]{0,500}self-referral Statflo identity is not allowed/);
});

test('Stripe purchase snapshots use net product revenue and survive guest reconciliation', () => {
  const webhook = read(WEBHOOK);
  const license = read(LICENSE_LIB);
  assert.match(webhook, /saleAmountCents\s*=\s*session\.amount_total/);
  assert.match(webhook, /session\.amount_subtotal[\s\S]{0,120}amount_discount/);
  assert.match(webhook, /sale_amount_cents:\s*saleAmountCents/);
  assert.match(webhook, /reward_basis_cents:\s*rewardBasisCents/);
  assert.match(license, /saleAmountCents\s*=\s*Number\(\(row\.metadata as any\)\?\.sale_amount_cents/);
  assert.match(license, /rewardBasisCents\s*=\s*Number\(\(row\.metadata as any\)\?\.reward_basis_cents/);
  assert.match(license, /checkout\.sessions\.retrieve\(row\.stripe_session_id\)/,
    'older pending purchases must recover exact amounts from Stripe, never guess');
});

test('ledger arithmetic: held accruals are pending, matured accruals are eligible', () => {
  // Mirrors getReferralBalance() so the rule is pinned independently of Supabase.
  const now = Date.now();
  const DAY = 86_400_000;
  const entries = [
    { entry_type: 'accrual', amount_cents: 1000, eligible_at: new Date(now + 10 * DAY).toISOString(), attribution_id: 'a1' },
    { entry_type: 'accrual', amount_cents: 1000, eligible_at: new Date(now - 1 * DAY).toISOString(),  attribution_id: 'a2' },
  ];

  const reversed = new Set(entries.filter(e => e.entry_type === 'reversal').map(e => e.attribution_id));
  let pending = 0, eligible = 0;
  for (const e of entries) {
    if (e.entry_type !== 'accrual' || reversed.has(e.attribution_id)) continue;
    if (new Date(e.eligible_at).getTime() > now) pending += e.amount_cents;
    else eligible += e.amount_cents;
  }

  assert.strictEqual(pending, 1000, 'the 10-day-old accrual is still held');
  assert.strictEqual(eligible, 1000, 'the matured accrual is payable');
});

// ── Reversals ────────────────────────────────────────────────────────────────

test('refunds and chargebacks both reverse, append-only', () => {
  const src = read(WEBHOOK);
  assert.match(src, /case 'charge\.refunded'/);
  assert.match(src, /case 'charge\.dispute\.created'/);
  assert.match(src, /cause:\s*'refund'/);
  assert.match(src, /cause:\s*'dispute'/);

  const lib = read(REFERRALS_LIB);
  const fn = lib.slice(lib.indexOf('export async function reverseReferralForCharge'));
  assert.match(fn, /rpc\('reverse_tiered_referral'/);
  const sql = read(TIER_MIGRATION);
  assert.match(sql, /create or replace function reverse_tiered_referral/);
  assert.match(sql, /'reversal', -v_accrual\.amount_cents/);
  assert.doesNotMatch(fn, /from\('referral_ledger'\)[\s\S]{0,120}\.(update|delete)\(/,
    'reversal must never mutate or delete the original accrual');
});

test('a reversal after payout produces a visible negative balance', () => {
  const src = read(REFERRALS_LIB);
  assert.match(src, /isNegative:\s*eligible < 0/);

  // Ledger sign discipline is also enforced in the database.
  const sql = read(MIGRATION);
  assert.match(sql, /entry_type = 'accrual'\s+and amount_cents > 0/);
  assert.match(sql, /entry_type in \('reversal','payout'\) and amount_cents < 0/);
});

/**
 * Reference implementation of the ledger rule in getReferralBalance().
 *
 * A reversed accrual is a PAIR: both entries are counted, or neither is.
 * Counting one without the other double-debits the referrer for one refund.
 */
function balanceOf(entries, now = Date.now()) {
  const reversedIds = new Set(
    entries.filter((e) => e.entry_type === 'reversal').map((e) => e.attribution_id)
  );
  const accrualById = new Map(
    entries.filter((e) => e.entry_type === 'accrual' && e.attribution_id)
           .map((e) => [e.attribution_id, e])
  );
  const matured = (e) => new Date(e.eligible_at).getTime() <= now;

  let pending = 0, eligible = 0;
  for (const e of entries) {
    if (e.entry_type === 'accrual') {
      if (reversedIds.has(e.attribution_id) && !matured(e)) continue;
      if (matured(e)) eligible += e.amount_cents;
      else pending += e.amount_cents;
    } else if (e.entry_type === 'reversal') {
      const accrual = e.attribution_id ? accrualById.get(e.attribution_id) : null;
      if (accrual && !matured(accrual)) continue;
      eligible += e.amount_cents;
    } else if (e.entry_type === 'payout') {
      eligible += e.amount_cents;
    }
  }
  return { pending, eligible };
}

test('ledger arithmetic: reversal after payout leaves exactly one reward of debt', () => {
  const now  = Date.now();
  const past = new Date(now - 86_400_000).toISOString();

  const { eligible } = balanceOf([
    { entry_type: 'accrual',  amount_cents:  1000, eligible_at: past, attribution_id: 'a1' },
    { entry_type: 'payout',   amount_cents: -1000, eligible_at: past, attribution_id: null },
    { entry_type: 'reversal', amount_cents: -1000, eligible_at: past, attribution_id: 'a1' },
  ], now);

  // Earned 1000, paid 1000, purchase reversed → owes exactly 1000, not 2000.
  assert.strictEqual(eligible, -1000,
    'a single refund must not debit the referrer twice');
});

test('ledger arithmetic: reversal BEFORE payout nets to zero, not a debt', () => {
  const now  = Date.now();
  const past = new Date(now - 86_400_000).toISOString();

  const { eligible } = balanceOf([
    { entry_type: 'accrual',  amount_cents:  1000, eligible_at: past, attribution_id: 'a1' },
    { entry_type: 'reversal', amount_cents: -1000, eligible_at: past, attribution_id: 'a1' },
  ], now);

  assert.strictEqual(eligible, 0, 'unpaid reward reversed → nothing owed either way');
});

test('ledger arithmetic: reversal during the hold shows neither pending nor debt', () => {
  const now    = Date.now();
  const future = new Date(now + 20 * 86_400_000).toISOString();

  const { pending, eligible } = balanceOf([
    { entry_type: 'accrual',  amount_cents:  1000, eligible_at: future,                      attribution_id: 'a1' },
    { entry_type: 'reversal', amount_cents: -1000, eligible_at: new Date(now).toISOString(), attribution_id: 'a1' },
  ], now);

  assert.strictEqual(pending, 0, 'money that is not coming must not show as pending');
  assert.strictEqual(eligible, 0, 'nothing was ever payable, so nothing is owed');
});

// ── Payout safety ────────────────────────────────────────────────────────────

test('payout execution is feature-flagged closed and the threshold fails closed when unset', () => {
  const src = read(REFERRALS_LIB);
  assert.match(src, /process\.env\.REFERRAL_PAYOUTS_ENABLED === 'true'/,
    'must default to disabled — only the exact string "true" enables it');
  assert.match(src, /REFERRAL_PAYOUT_THRESHOLD_CENTS/);

  // The threshold is an owner decision with no default in code. An unset env
  // var must fail closed (null) exactly like a malformed or too-low one —
  // money movement must never proceed on an inferred threshold.
  assert.match(src, /if \(!raw\) return null/,
    'an unset threshold must fail closed, not fall back to a default');
  assert.match(src, /parsed < REFERRAL_ACCRUAL_CENTS\) return null/,
    'an env value below one reward must also fail closed, not silently apply');
});

/**
 * Reference implementation of getPayoutThresholdCents(), mirroring the ledger
 * arithmetic tests above. referrals.ts pulls in next/headers transitively, so
 * it cannot be booted directly in this plain node:test suite (see file header)
 * — this pins the fail-closed behavior independently of that constraint.
 */
function payoutThresholdCentsOf(raw, accrualCents = 1000) {
  if (!raw) return null;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < accrualCents) return null;
  return parsed;
}

test('threshold resolution fails closed for unset, malformed, and too-low values', () => {
  assert.strictEqual(payoutThresholdCentsOf(undefined), null, 'unset must fail closed');
  assert.strictEqual(payoutThresholdCentsOf(''), null, 'empty must fail closed');
  assert.strictEqual(payoutThresholdCentsOf('not-a-number'), null, 'malformed must fail closed');
  assert.strictEqual(payoutThresholdCentsOf('500'), null, 'below the $10.00 floor must fail closed');
  assert.strictEqual(payoutThresholdCentsOf('2500'), 2500, 'a valid explicit threshold is honored');
});

test('bank enrollment is simple and privacy-safe on both customer surfaces', () => {
  for (const panel of [read(WEB_PANEL), read(DESKTOP_PANEL)]) {
    assert.match(panel, /Connect bank securely/);
    assert.match(panel, /Finish bank setup/);
    assert.match(panel, /Bank deposit ready/);
    assert.match(panel, /Stripe securely collects your bank details/);
    assert.match(panel, /StatfloBot never[\s\S]{0,100}stores your bank account or routing numbers/);
    assert.match(panel, /automatic bank deposit each day after the 30-day hold/);
    assert.doesNotMatch(panel, />Set up payouts</);
    assert.doesNotMatch(panel, />Payout account ready</);
  }
});

test('bank setup failures stay friendly and each retry requests a fresh hosted link', () => {
  const payouts = read(PAYOUTS_LIB);
  const route = read('monetization/web/app/api/referrals/connect/onboard/route.ts');
  const desktopApi = read(CLOUD_API);
  assert.match(payouts, /createGlobalRecipientLink/);
  assert.doesNotMatch(payouts, /Stripe Global Payouts is not enabled for this account/);
  assert.match(route, /Bank setup is available to lifetime customers/);
  assert.match(desktopApi, /Could not start bank setup\. Please try again\./);
});

test('owner payout queue shows bank readiness and the next required action', () => {
  const admin = read('monetization/web/app/admin/AdminReferrals.tsx');
  for (const phrase of [
    'not connected',
    'bank setup incomplete',
    'Waiting for bank connection',
    'Waiting for bank setup',
    'Set payout threshold',
    'Payout sending disabled',
    'Ready for owner review',
  ]) assert.match(admin, new RegExp(phrase));
});

test('preflight blocks payouts below threshold, without Global Payouts readiness, or when negative', () => {
  const src = read(PAYOUTS_LIB);
  for (const reason of [
    'payouts-disabled',
    'threshold-not-configured',
    'financial-account-not-configured',
    'below-threshold',
    'no-global-recipient',
    'payout-method-not-ready',
    'negative-balance',
  ]) {
    assert.ok(src.includes(`'${reason}'`), `preflight must handle ${reason}`);
  }
});

test('automatic payout execution exists only behind the protected daily cron', () => {
  // Webhooks, checkout and public referral routes can never move money.
  const callers = [WEBHOOK, LICENSE_LIB, REFERRALS_LIB,
    'monetization/web/app/api/referrals/summary/route.ts',
    'monetization/web/app/api/referrals/code/route.ts'];
  for (const f of callers) {
    assert.doesNotMatch(read(f), /executeApprovedPayout/,
      `${f} must not be able to move money`);
  }
  assert.match(read(ADMIN_PAYOUT), /executeApprovedPayout/);
  assert.match(read(AUTO_PAYOUTS), /executeApprovedPayout/);
  assert.match(read(AUTO_PAYOUT_ROUTE), /CRON_SECRET/);
  assert.match(read(AUTO_PAYOUT_ROUTE), /authorization.*Bearer/);
});

test('automatic payouts require both exact-true switches and preserve the $25 reward ceiling', () => {
  const auto = read(AUTO_PAYOUTS);
  const referrals = read(REFERRALS_LIB);
  assert.match(auto, /REFERRAL_AUTO_PAYOUTS_ENABLED === 'true'/);
  assert.match(auto, /manualPayoutsEnabled: arePayoutsEnabled\(\)/);
  assert.match(auto, /!config\.enabled \|\| !config\.manualPayoutsEnabled/);
  assert.match(referrals, /STANDARD_REFERRAL_REWARD_TIERS[\s\S]*cents: 2500/);
  assert.doesNotMatch(referrals, /STANDARD_REFERRAL_REWARD_TIERS[\s\S]{0,300}cents: (?:[3-9]\d{3}|\d{5,})/);
});

test('automatic payouts fail closed on funding, reserve, daily caps and annual review', () => {
  const auto = read(AUTO_PAYOUTS);
  assert.match(auto, /DEFAULT_RESERVE_CENTS = 2500/);
  assert.match(auto, /DEFAULT_BANK_FEE_CENTS = 150/);
  assert.match(auto, /DEFAULT_RECIPIENT_DAILY_CAP_CENTS = 10_000/);
  assert.match(auto, /DEFAULT_GLOBAL_DAILY_CAP_CENTS = 25_000/);
  assert.match(auto, /DEFAULT_ANNUAL_REVIEW_CENTS = 150_000/);
  assert.match(auto, /availableCents < required/);
  assert.match(auto, /shortfallCents: required - availableCents/);
  assert.match(auto, /reason: 'recipient-daily-cap'/);
  assert.match(auto, /reason: 'global-daily-cap'/);
  assert.match(auto, /reason: 'annual-tax-review'/);
  assert.match(auto, /hasRealLifetimeEntitlement\(referrerUserId\)/);
});

test('Financial Account available USD uses Stripe v2 currency-map shape', () => {
  const source = read(GLOBAL_PAYOUTS);
  const retrieve = source.slice(
    source.indexOf('export async function retrieveGlobalFinancialAccount'),
    source.indexOf('export function availableUsdCents')
  );
  assert.match(source, /available\?: Record<string,[\s\S]{0,100}value\?: number \| string/);
  assert.match(source, /available\?\.usd\?\.value/);
  assert.doesNotMatch(source, /available\?\.find/);
  assert.doesNotMatch(retrieve, /URLSearchParams|query\.append|\?\$\{/);
});

test('daily cron delivery is globally leased and duplicate invocations cannot both run', () => {
  const auto = read(AUTO_PAYOUTS);
  const sql = read(AUTO_PAYOUT_MIGRATION);
  const vercel = read(VERCEL_CONFIG);
  assert.match(auto, /claim_referral_auto_payout_run/);
  assert.match(auto, /already-run-or-running/);
  assert.match(sql, /run_date\s+date primary key/);
  assert.match(sql, /on conflict \(run_date\) do update/);
  assert.match(sql, /lease_expires_at < now\(\)/);
  assert.match(sql, /status = 'running'/);
  assert.match(vercel, /api\/cron\/referral-payouts/);
});

test('Global Payouts carry an idempotency key and reserve the ledger before sending', () => {
  const src = read(PAYOUTS_LIB);
  const api = read(GLOBAL_PAYOUTS);
  const sql = read(PAYOUT_MIGRATION);
  assert.match(api, /idempotencyKey:\s*input\.idempotencyKey/);
  assert.match(api, /Idempotency-Key/);
  assert.match(sql, /insert into referral_ledger[\s\S]*'payout'/);

  const reserveAt  = src.indexOf("rpc('reserve_global_referral_payout'");
  const outboundAt = src.indexOf('await createGlobalOutboundPayment(');
  assert.ok(reserveAt > 0 && outboundAt > reserveAt,
    'the atomic ledger reservation must happen before the outbound payment');
});

test('definite rejection restores the balance while ambiguous failures remain retryable', () => {
  const src = read(PAYOUTS_LIB);
  const sql = read(PAYOUT_MIGRATION);
  assert.match(src, /definiteRejection/);
  assert.match(src, /p_succeeded:\s*false/);
  assert.match(src, /status is still being confirmed/i);
  assert.match(sql, /delete from referral_ledger[\s\S]*entry_type = 'payout'/);
  assert.match(src, /same Stripe[\s\S]*idempotency key/i);
});

test('payout and audit routes are gated exclusively through isAdminEmail()', () => {
  for (const f of [ADMIN_PAYOUT, ADMIN_AUDIT]) {
    const src = read(f);
    assert.match(src, /isAdminEmail\(user\.email\)/);
    assert.match(src, /status:\s*403/);
    assert.doesNotMatch(src, /process\.env\.ADMIN_EMAILS/,
      `${f} must not reimplement the admin check inline`);
  }
});

test('money movement requires the authenticated owner plus an exact typed confirmation', () => {
  const route = read(ADMIN_PAYOUT);
  const admin = read(ADMIN_LIB);
  assert.match(admin, /export function isOwnerEmail/);
  assert.match(route, /if \(!isOwnerEmail\(user\.email\)\)/);
  assert.match(route, /expectedConfirmation = codeRow\?\.code \? `PAY \$\{codeRow\.code\}`/);
  assert.match(route, /Only the StatfloBot owner can approve referral payouts/);
  const ownerUi = read('monetization/web/app/admin/AdminReferrals.tsx');
  assert.match(ownerUi, /const expected = `PAY \$\{r\.code\}`/);
  assert.match(ownerUi, /type exactly:[\s\S]{0,120}\$\{expected\}/);
});

test('the admin page uses isAdminEmail() and no longer logs the admin email list', () => {
  const page = read(ADMIN_PAGE);
  assert.match(page, /isAdminEmail\(user\.email\)/);
  assert.doesNotMatch(page, /adminEmails\.includes/,
    'the case-sensitive inline gate that ignored the hardcoded owner must be gone');

  const lib = read(ADMIN_LIB);
  assert.doesNotMatch(lib, /values=\$\{allAdmins/,
    'admin addresses must not be printed to logs');
  assert.match(lib, /ADMIN_EMAILS_LOADED\] count=/);
});

test('the desktop proxy cannot reach payout approval', () => {
  const proxy = read(PROXY);
  assert.match(proxy, /\/api\/proxy\/referrals\/summary/);
  assert.match(proxy, /\/api\/proxy\/referrals\/validate/);
  assert.doesNotMatch(proxy, /admin\/referrals\/payout/,
    'money movement must not be reachable from the desktop app');
});

// ── Terms + final sale ───────────────────────────────────────────────────────

test('lifetime checkout requires terms acceptance server-side', () => {
  const src = read(CHECKOUT_LIFE);
  assert.match(src, /requestBody\?\.termsAccepted !== true/);
  assert.match(src, /code:\s*'terms-required'/);
  assert.match(src, /status:\s*400/);
});

test('a versioned acceptance is recorded in Stripe metadata, not just the client checkbox', () => {
  const src = read(CHECKOUT_LIFE);
  assert.match(src, /terms_version:\s*TERMS_VERSION/);
  assert.match(src, /terms_accepted_at:\s*termsAcceptedAt/);
  assert.match(src, /new Date\(\)\.toISOString\(\)/, 'timestamp must be generated server-side');
});

test("Stripe's own terms checkbox is required, with an actionable config error", () => {
  const src = read(CHECKOUT_LIFE);
  assert.match(src, /terms_of_service:\s*'required'/);
  assert.match(src, /stripe-tos-url-missing/);
  assert.match(src, /Dashboard.{0,40}Checkout and Payment/i);
});

test('Terms state final sale, preserve legal rights, and never bar disputes', () => {
  const src = read(TERMS);

  assert.match(src, /final and non-refundable/i);
  assert.match(src, /except where a refund is required by\s*\n?\s*applicable law/i);
  assert.match(src, /Nothing in these terms prevents you from disputing a charge/i);

  // The old conflicting promise must be gone.
  assert.doesNotMatch(src, /case-by-case basis/i);
  assert.doesNotMatch(src, /within 14 days of purchase/i);

  // Must not imply disputes are impossible or prohibited.
  for (const forbidden of [/waive.{0,30}chargeback/i, /may not dispute/i, /disputes are not permitted/i]) {
    assert.doesNotMatch(src, forbidden);
  }

  // Monthly cancellation is unchanged.
  assert.match(src, /cancel at any time/i);
});

test('Terms document the referral program rules the owner fixed', () => {
  const src = read(TERMS);
  assert.match(src, /\$10\.00/);
  assert.match(src, /30 days/);
  assert.match(src, /cannot be applied\s*\n?\s*retroactively/i);
  assert.match(src, /lifetime purchases only/i);
  assert.match(src, /do not receive a discount/i);
  assert.match(src, /responsible for any tax/i);
  assert.match(src, /never\s*\n?\s*collect or store your bank details/i);
});

test('the terms version in code matches the published Terms date', () => {
  assert.match(read(REFERRALS_LIB), /TERMS_VERSION\s*=\s*'2026-08-13'/);
  assert.match(read(TERMS), /Last updated: August 13, 2026/);
});

// ── Site / desktop parity ────────────────────────────────────────────────────

test('the website sends termsAccepted and requires the checkbox', () => {
  const src = read(PRICING_CARD);
  assert.match(src, /termsAccepted: finalSaleOk/);
  assert.match(src, /disabled=\{loading \|\| \(isLifetime && !finalSaleOk\)\}/);
  assert.match(src, /Final sale · non-refundable except where required by law/);

  // The old bodyless POST must be gone, or the server would never see acceptance.
  assert.doesNotMatch(src, /fetch\(endpoint,\s*\{\s*method:\s*'POST'\s*\}\)/);
});

test('the desktop path cannot bypass the acknowledgment', () => {
  const api = read(CLOUD_API);
  assert.match(api, /opts\.termsAccepted !== true/,
    'the desktop client must refuse to open checkout without acceptance');
  assert.match(api, /termsAccepted: true/);

  const dialog = read(DESKTOP_DIALOG);
  assert.match(dialog, /final sale/i);
  assert.match(dialog, /disabled=\{loading \|\| !accepted\}/);
});

test('both surfaces accept an optional referral code the same way', () => {
  for (const f of [PRICING_CARD, DESKTOP_DIALOG]) {
    const src = read(f);
    assert.match(src, /referralCode/);
    assert.match(src, /optional/i);
  }
  // And the server treats them identically — one route, one validation.
  const route = read(CHECKOUT_LIFE);
  assert.strictEqual((route.match(/validateReferralCode\(/g) ?? []).length, 1);
});

// ── Code generation ──────────────────────────────────────────────────────────

test('referral codes use crypto randomness and an unambiguous alphabet', () => {
  const src = read(REFERRALS_LIB);
  assert.match(src, /require\(|from 'crypto'/);
  assert.match(src, /randomInt\(0, CODE_ALPHABET\.length\)/);
  assert.doesNotMatch(src.slice(src.indexOf('generateReferralCode')), /Math\.random/,
    'codes are guessed against a public endpoint — Math.random is not acceptable');

  const alphabet = src.match(/CODE_ALPHABET = '([^']+)'/)[1];
  for (const ambiguous of ['I', 'L', 'O', 'U', '0', '1']) {
    assert.ok(!alphabet.includes(ambiguous), `alphabet must exclude ${ambiguous}`);
  }
});

test('code normalization never remaps one valid code onto another', () => {
  const src = read(REFERRALS_LIB);
  const fn = src.slice(src.indexOf('export function normalizeReferralCode'),
                       src.indexOf('export function isWellFormedReferralCode'));
  // Case and separators only. Any lookalike folding could resolve a typo onto a
  // DIFFERENT referrer's real code.
  assert.match(fn, /toUpperCase\(\)/);
  assert.match(fn, /replace\(\/\[\\s-\]\/g, ''\)/);
  assert.doesNotMatch(fn, /replace\(\/0\/g/);
  assert.doesNotMatch(fn, /replace\(\/\[ILOU\]/);
});

test('the DB rejects a code that is not in the issued format', () => {
  const sql = read(MIGRATION);
  assert.match(sql, /referral_codes_format check \(code ~ '\^\[ABCDEFGHJKMNPQRSTVWXYZ23456789\]\{10\}\$'\)/);
});

// ── Validation endpoint privacy ──────────────────────────────────────────────

test('the validation endpoint is rate limited and does not leak code existence', () => {
  const src = read('monetization/web/app/api/referrals/validate/route.ts');
  assert.match(src, /rateLimited\(/);
  assert.match(src, /status:\s*429/);

  // A generic message for the enumeration-sensitive cases.
  assert.match(src, /That code isn't valid\./);
  assert.doesNotMatch(src, /not-found.{0,60}(no such|does not exist)/i);
  // Never reveals the referrer.
  assert.doesNotMatch(src, /referrerUserId/);
});

test('the referrer is never told who bought', () => {
  const src = read('monetization/web/app/api/referrals/summary/route.ts');
  const mapBlock = src.slice(src.indexOf('const referrals ='), src.indexOf('const thresholdCents'));
  for (const leak of ['referred_email', 'referred_user_id', 'stripe_session_id']) {
    assert.ok(!mapBlock.includes(leak), `summary must not expose ${leak} to the referrer`);
  }
});

// ── Where a lifetime customer finds their code ───────────────────────────────

test('the code is issued and displayed on both the website and the desktop app', () => {
  // One endpoint mints/returns the single code...
  const route = read('monetization/web/app/api/referrals/code/route.ts');
  assert.match(route, /getOrCreateReferralCode\(user\.id, user\.email\)/);
  assert.match(route, /status:\s*401/, 'must require authentication');

  // ...and both surfaces render it with a copy control.
  for (const f of [WEB_PANEL, DESKTOP_PANEL]) {
    const src = read(f);
    assert.match(src, /Your referral code/i, `${f} must label the code`);
    assert.match(src, /\{code\}/, `${f} must render the code`);
    assert.match(src, /handleCopy/, `${f} must offer a copy control`);
    assert.match(src, /createReferralCode|\/api\/referrals\/code/,
      `${f} must be able to mint the code on first use`);
  }
});

test('the panel is hidden from non-lifetime and admin accounts on both surfaces', () => {
  for (const f of [WEB_PANEL, DESKTOP_PANEL]) {
    const src = read(f);
    assert.match(src, /if \(!isLifetime \|\| isAdmin\) return null/,
      `${f} must self-hide for ineligible viewers`);
  }
  // And the host screens pass a REAL active lifetime entitlement, not a guess.
  assert.match(read('monetization/web/app/dashboard/DashboardClient.tsx'),
    /isLifetime=\{license\?\.plan === 'lifetime' && license\?\.status === 'active'\}/);
  assert.match(read('ui/client/src/screens/AccountScreen.jsx'),
    /isLifetime=\{isLifetime && licStatus === 'active'\}/);

  // Client-side hiding is cosmetic; the server is the real gate.
  assert.match(read(REFERRALS_LIB), /if \(isAdminEmail\(email\)\) return \{ ok: false, reason: 'admin-excluded' \}/);
});

// ── Pending referrals: applied before payment ────────────────────────────────

test('a reservation is written at Session creation and never blocks a checkout', () => {
  const src = read(CHECKOUT_LIFE);

  // Written only after Stripe accepted the session, so a reservation cannot
  // exist for a session that was never created.
  const createAt  = src.indexOf('await stripe.checkout.sessions.create(sessionParams)');
  const reserveAt = src.indexOf('await reserveReferral(');
  assert.ok(createAt > 0 && reserveAt > createAt, 'reserve must follow session creation');

  // Best effort: wrapped so a reservation failure cannot fail the purchase.
  const block = src.slice(createAt, src.indexOf('CHECKOUT_API_SUCCESS'));
  assert.match(block, /try \{[\s\S]*reserveReferral\([\s\S]*\} catch/,
    'a reservation failure must never break checkout');
});

test('a reservation is not money and no balance reads it', () => {
  const lib = read(REFERRALS_LIB);
  const fn  = lib.slice(lib.indexOf('export async function reserveReferral'),
                        lib.indexOf('export async function settleReservation'));
  assert.doesNotMatch(fn, /referral_ledger/, 'reserving must never touch the ledger');
  assert.doesNotMatch(fn, /amount_cents/,    'a reservation carries no amount');

  const balance = lib.slice(lib.indexOf('export async function getReferralBalance'),
                            lib.indexOf('// ── Reservations'));
  assert.doesNotMatch(balance, /referral_reservations/,
    'balances must be computed from the ledger alone');

  assert.doesNotMatch(read(PAYOUTS_LIB), /referral_reservations/,
    'payout preflight must never consider unpaid checkouts');
});

test('reservations settle on completion and expiry, and only ever leave "reserved"', () => {
  const hook = read(WEBHOOK);
  assert.match(hook, /settleReservation\(session\.id, 'converted'\)/);
  assert.match(hook, /case 'checkout\.session\.expired'/);
  assert.match(hook, /settleReservation\(session\.id, 'expired'\)/);

  const lib = read(REFERRALS_LIB);
  const fn  = lib.slice(lib.indexOf('export async function settleReservation'));
  assert.match(fn, /\.eq\('status', 'reserved'\)/,
    'a replayed event must not revive or reclassify a settled reservation');
});

test('the reservation table is lifetime-only, service-role, and non-monetary', () => {
  const sql = read(MIGRATION);
  const hardened = read(TIER_MIGRATION);
  assert.match(sql, /create table if not exists referral_reservations/);
  assert.match(hardened, /constraint referral_reservations_lifetime_only\s+check \(plan_code in \('lifetime_early', 'lifetime_standard'\)\)/);
  assert.match(sql, /alter table referral_reservations enable row level security/);
  assert.match(sql, /on referral_reservations\s*\n?\s*for all to service_role/);

  const block = sql.slice(sql.indexOf('create table if not exists referral_reservations'),
                          sql.indexOf('-- ── referral_ledger'));
  assert.doesNotMatch(block, /amount_cents/, 'reservations must carry no amount');
});

test('the summary exposes a pending entry without identifying the buyer', () => {
  const src = read(SUMMARY);
  assert.match(src, /from\('referral_reservations'\)/);
  assert.match(src, /\.neq\('status', 'converted'\)/,
    'a converted reservation is represented by its attribution, not twice');

  // Only a date and a status leave the server.
  assert.match(src, /\.select\('created_at, expires_at, status'\)/);
  const block = src.slice(src.indexOf('from(\'referral_reservations\')'), src.indexOf('const { data: reversals }'));
  for (const leak of ['referred_email', 'stripe_session_id', 'referral_code']) {
    assert.ok(!block.includes(leak), `summary must not expose ${leak}`);
  }
});

// ── Status machine (exercises the REAL shipped function) ─────────────────────
//
// lib/referralStatus.ts has no imports, so Node's type stripping can load it
// directly. These are behavioural tests of shipped code, not a re-implementation.

const STATUS_MOD = new URL('../monetization/web/lib/referralStatus.ts', `file://${__filename}`).href;
const loadStatus = () => import(STATUS_MOD);

const DAY  = 86_400_000;
const NOW  = Date.parse('2026-08-11T12:00:00Z');
const iso  = (offsetMs) => new Date(NOW + offsetMs).toISOString();
const base = { reservations: [], attributions: [], accruals: [], reversedAttributionIds: [], paidCents: 0, now: NOW };

test('a live reservation shows as "code applied — not paid yet"', async () => {
  const { deriveReferralTimeline } = await loadStatus();

  const out = deriveReferralTimeline({
    ...base,
    reservations: [{ createdAt: iso(-2 * 3_600_000), expiresAt: iso(22 * 3_600_000), status: 'reserved' }],
  });

  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].status, 'code_applied');
  assert.strictEqual(out[0].label, 'Code applied — not paid yet');
  assert.strictEqual(out[0].eligibleAt, null, 'nothing is maturing — no money exists yet');
});

test('an expired or abandoned reservation reads as "checkout not completed"', async () => {
  const { deriveReferralTimeline } = await loadStatus();

  const out = deriveReferralTimeline({
    ...base,
    reservations: [
      // Settled by the webhook.
      { createdAt: iso(-3 * DAY), expiresAt: iso(-2 * DAY), status: 'expired' },
      // Never settled, but past its TTL — must not linger as "code applied".
      { createdAt: iso(-5 * DAY), expiresAt: iso(-4 * DAY), status: 'reserved' },
    ],
  });

  assert.strictEqual(out.length, 2);
  for (const item of out) {
    assert.strictEqual(item.status, 'not_completed');
    assert.strictEqual(item.label, 'Checkout not completed');
  }
});

test('a converted reservation is not double-counted alongside its purchase', async () => {
  const { deriveReferralTimeline } = await loadStatus();

  const out = deriveReferralTimeline({
    ...base,
    reservations: [{ createdAt: iso(-1 * DAY), expiresAt: iso(0), status: 'converted' }],
    attributions: [{ id: 'a1', createdAt: iso(-1 * DAY) }],
    accruals:     [{ attributionId: 'a1', eligibleAt: iso(29 * DAY), amountCents: 1000 }],
  });

  assert.strictEqual(out.length, 1, 'the purchase replaces its reservation, it does not add to it');
  assert.strictEqual(out[0].status, 'purchased');
});

test('the full lifecycle: applied → purchased → available → paid', async () => {
  const { deriveReferralTimeline } = await loadStatus();

  const out = deriveReferralTimeline({
    ...base,
    reservations: [{ createdAt: iso(-1 * 3_600_000), expiresAt: iso(23 * 3_600_000), status: 'reserved' }],
    attributions: [
      { id: 'held',  createdAt: iso(-5 * DAY)  },  // inside the hold
      { id: 'ready', createdAt: iso(-40 * DAY) },  // matured, unpaid
      { id: 'sent',  createdAt: iso(-90 * DAY) },  // matured, covered by a payout
    ],
    accruals: [
      { attributionId: 'held',  eligibleAt: iso(25 * DAY),  amountCents: 1500 },
      { attributionId: 'ready', eligibleAt: iso(-10 * DAY), amountCents: 1500 },
      { attributionId: 'sent',  eligibleAt: iso(-60 * DAY), amountCents: 1000 },
    ],
    paidCents: 1000, // exactly one reward has been paid out
  });

  const byStatus = Object.fromEntries(out.map((o) => [o.status, o]));
  assert.ok(byStatus.code_applied, 'the unpaid checkout is still visible');
  assert.ok(byStatus.purchased,    'the held purchase is clearing');
  assert.ok(byStatus.available,    'the matured, unpaid reward is payable');
  assert.ok(byStatus.paid,         'the oldest matured reward is marked paid');

  // FIFO: the payout covered the OLDEST matured reward, not the newest.
  assert.strictEqual(byStatus.paid.at, iso(-90 * DAY));
  assert.strictEqual(byStatus.available.at, iso(-40 * DAY));

  // Newest first.
  const times = out.map((o) => Date.parse(o.at));
  assert.deepStrictEqual(times, [...times].sort((a, b) => b - a));
});

test('a reversed purchase is reported as reversed, never as payable', async () => {
  const { deriveReferralTimeline } = await loadStatus();

  const out = deriveReferralTimeline({
    ...base,
    attributions:           [{ id: 'a1', createdAt: iso(-60 * DAY) }],
    accruals:               [{ attributionId: 'a1', eligibleAt: iso(-30 * DAY), amountCents: 1500 }],
    reversedAttributionIds: ['a1'],
    paidCents:              1000,
  });

  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].status, 'reversed');
  assert.match(out[0].label, /refunded/i);
});

test('a purchase with no accrual row is never shown as payable', async () => {
  const { deriveReferralTimeline } = await loadStatus();

  // The purchase landed but the reward write did not. Failing closed here means
  // "still clearing", never "ready for payout" — the UI must not promise money
  // the ledger has no record of.
  const out = deriveReferralTimeline({
    ...base,
    attributions: [{ id: 'orphan', createdAt: iso(-90 * DAY) }],
    accruals:     [],
  });

  assert.strictEqual(out[0].status, 'purchased');
  assert.notStrictEqual(out[0].status, 'available');
});

test('payout coverage never marks more referrals paid than were actually paid for', async () => {
  const { deriveReferralTimeline } = await loadStatus();

  const out = deriveReferralTimeline({
    ...base,
    attributions: [
      { id: 'a1', createdAt: iso(-90 * DAY) },
      { id: 'a2', createdAt: iso(-80 * DAY) },
      { id: 'a3', createdAt: iso(-70 * DAY) },
    ],
    accruals: [
      { attributionId: 'a1', eligibleAt: iso(-60 * DAY), amountCents: 1000 },
      { attributionId: 'a2', eligibleAt: iso(-50 * DAY), amountCents: 1500 },
      { attributionId: 'a3', eligibleAt: iso(-40 * DAY), amountCents: 2000 },
    ],
    paidCents: 1500, // one and a half rewards — a partial must not round up
  });

  assert.strictEqual(out.filter((o) => o.status === 'paid').length, 1);
  assert.strictEqual(out.filter((o) => o.status === 'available').length, 2);
});

test('every status has a plain-language label and explanation', async () => {
  const { REFERRAL_STATUS_LABELS, referralStatusDescriptions } = await loadStatus();
  const descriptions = referralStatusDescriptions(30);

  for (const status of ['code_applied', 'not_completed', 'purchased', 'available', 'paid', 'reversed']) {
    assert.ok(REFERRAL_STATUS_LABELS[status]?.length > 3, `${status} needs a label`);
    assert.ok(descriptions[status]?.length > 10, `${status} needs an explanation`);
    // No raw enum names or developer jargon in customer-facing copy.
    assert.doesNotMatch(REFERRAL_STATUS_LABELS[status], /_|accrual|ledger|attribution/i);
  }

  // Nothing may promise an automatic transfer — payouts are approved by hand.
  const copy = Object.values(REFERRAL_STATUS_LABELS).concat(Object.values(descriptions)).join(' ');
  for (const forbidden of [/automatic/i, /automatically (paid|sent|transferred)/i, /deposited/i]) {
    assert.doesNotMatch(copy, forbidden);
  }
});

test('the status machine is pure — no I/O, no ambient clock', () => {
  const src = readCode('monetization/web/lib/referralStatus.ts');
  assert.doesNotMatch(src, /^import /m, 'must have no imports so it stays directly testable');
  for (const forbidden of [/createServiceClient/, /supabase/i, /stripe/i, /process\.env/, /fetch\(/]) {
    assert.doesNotMatch(src, forbidden);
  }
  assert.match(read('monetization/web/lib/referralStatus.ts'), /input\.now \?\? Date\.now\(\)/,
    'the clock must be injectable');
});

// ── UI honesty ───────────────────────────────────────────────────────────────

test('both panels describe automatic payout honestly and retain disabled-state copy', () => {
  for (const f of [WEB_PANEL, DESKTOP_PANEL]) {
    const src = read(f);
    assert.match(src, /scheduled for automatic bank deposit/,
      `${f} must explain the daily automatic bank-deposit path`);
    assert.match(src, /program funds are available/,
      `${f} must not promise a deposit when the Financial Account lacks funds`);
    assert.match(src, /payoutsConfigured === false/,
      `${f} must soften the copy when money movement is flagged off`);
  }
});

test('both panels render the applied-but-unpaid state and say it earns nothing yet', () => {
  for (const f of [WEB_PANEL, DESKTOP_PANEL]) {
    const src = read(f);
    assert.match(src, /code_applied/, `${f} must handle the applied-not-paid status`);
    assert.match(src, /awaitingPayment/, `${f} must surface the awaiting-payment count`);
    assert.match(src, /earns nothing until that purchase is paid for/i,
      `${f} must say plainly that an applied code is not earned money`);
    assert.match(src, /never identified/i, `${f} must state the privacy guarantee`);

    // The bare word "Pending" was ambiguous between the two meanings.
    assert.doesNotMatch(src, /`Pending \(\$\{holdDays\}d\)`/,
      `${f} must not label the hold "Pending" — it collides with applied-not-paid`);
  }
});

test('both Rewards Hubs show tier progress, exact amounts, privacy, and no inactive bank action', () => {
  const summary = read(SUMMARY);
  assert.match(summary, /currentRateCents/);
  assert.match(summary, /nextRateCents/);
  assert.match(summary, /netQualifiedCount/);
  assert.match(summary, /amountCents:\s*a\.amount_cents/);

  for (const f of [WEB_PANEL, DESKTOP_PANEL]) {
    const src = read(f);
    assert.match(src, /Referral Rewards/);
    assert.match(src, /rewards\?\.currentRateCents/);
    assert.match(src, /rewards\.referralsToUnlock/);
    assert.match(src, /\['\$10', '\$15', '\$20', '\$25 max'\]/);
    assert.match(src, /r\.amountCents/);
    assert.match(src, /bankReady\s*=\s*!!payoutAccount\.payoutsEnabled/,
      `${f} must derive bank readiness from payoutAccount.payoutsEnabled`);
    assert.match(src, /canConnectBank\s*=\s*!bankReady\s*&&\s*payoutsConfigured\s*!==\s*false/,
      `${f} must not offer bank onboarding while payouts are disabled`);
    assert.match(src, /\{canConnectBank &&/,
      `${f} must gate the bank connect button on canConnectBank`);
    assert.doesNotMatch(readCode(f), /referred_email|referredUserId|customer_email/i,
      `${f} must never receive or render referred-buyer identity`);
    assert.doesNotMatch(src, /jackpot|casino|gambl|wager/i,
      `${f} must keep reward progress professional`);
  }
});

// ── Guest-path self-referral ─────────────────────────────────────────────────

test('the guest path checks self-referral by email, which checkout could not', () => {
  // At Session creation a guest has no account and no typed email, so
  // validateReferralCode() saw `email: null` and could only check the code.
  // The webhook is the first and only place this check can run for a guest.
  const src = read(WEBHOOK);
  const block = src.slice(src.indexOf('Guest referral snapshot'),
                         src.indexOf("from('pending_purchases').upsert"));

  assert.match(block, /getUserEmail\(session\.metadata\.referrer_user_id\)/);
  assert.match(block, /referrerEmail === pendingEmail/);
  assert.match(block, /reason: 'self-referral'/);

  // And it must gate the snapshot, not merely log.
  const gateAt = block.indexOf('selfReferral');
  const snapAt = block.indexOf('guestReferral.referrer_user_id =');
  assert.ok(gateAt > 0 && gateAt < snapAt, 'the check must precede the snapshot write');
});

// ── Payout concurrency ───────────────────────────────────────────────────────

test('a second payout approval cannot draw on the same balance', () => {
  const src = read(PAYOUTS_LIB);
  const sql = read(PAYOUT_MIGRATION);

  // Existing processing rows are resumed with the same provider idempotency
  // key rather than starting a second payout.
  assert.match(src, /\.eq\('status', 'processing'\)/);
  assert.match(src, /resumed:\s*true/);
  assert.match(sql, /pg_advisory_xact_lock[\s\S]*referral-payout:/);
  assert.match(sql, /status = 'processing'[\s\S]*for update/);
  assert.match(sql, /insert into referral_payouts[\s\S]*insert into referral_ledger/);
  assert.match(sql, /idempotency_key[\s\S]*v_payout_id/);
});

test('a resumed payout with a Stripe outbound id is retrieved, never submitted again', () => {
  const src = read(PAYOUTS_LIB);
  assert.match(src, /select\('id, amount_cents, idempotency_key, stripe_recipient_id, stripe_payout_method_id, stripe_outbound_payment_id'\)/);
  assert.match(src, /if \(reserved\.stripe_outbound_payment_id\)[\s\S]{0,500}retrieveGlobalOutboundPayment\(outboundId\)/);
});

test('buyer lookup fails closed when its auth scan reaches the safety cap', () => {
  const src = read(REFERRALS_LIB);
  assert.match(src, /class ReferralUserLookupError extends Error/);
  assert.match(src, /REFERRAL_USER_LOOKUP_EXHAUSTED/);
  assert.match(src, /return \{ isNew: false, reason: 'user-lookup-unavailable' \}/);
});

test('Global Payouts uses separate identifiers and never reinterprets legacy Connect accounts', () => {
  const sql = read(PAYOUT_MIGRATION);
  const api = read(GLOBAL_PAYOUTS);
  assert.match(sql, /stripe_recipient_id/);
  assert.match(sql, /stripe_payout_method_id/);
  assert.match(sql, /stripe_outbound_payment_id/);
  assert.doesNotMatch(sql, /set\s+stripe_recipient_id\s*=\s*stripe_account_id/i);
  assert.match(api, /\/v2\/core\/accounts/);
  assert.match(api, /\/v2\/core\/account_links/);
  assert.match(api, /\/v2\/money_management\/outbound_payments/);
  assert.doesNotMatch(readCode(PAYOUTS_LIB), /stripe\.transfers\.create|stripe\.accounts\.create/);
});

test('Global Payout lifecycle distinguishes processing, posted, and returned money', () => {
  const payouts = read(PAYOUTS_LIB);
  const api = read(GLOBAL_PAYOUTS);
  const sql = read(PAYOUT_MIGRATION);
  const referrals = read(REFERRALS_LIB);

  assert.match(api, /retrieveGlobalOutboundPayment/);
  assert.match(api, /processing.*posted.*failed.*returned.*canceled/);
  assert.match(payouts, /status === 'posted'/);
  assert.match(payouts, /TERMINAL_FAILURE_STATUSES/);
  assert.match(payouts, /reconcileProcessingPayouts/);
  assert.match(sql, /record_global_referral_payout_submission/);
  assert.match(sql, /stripe_outbound_payment_status = 'posted'/);
  assert.match(referrals, /processingCents/);

  for (const f of [WEB_PANEL, DESKTOP_PANEL]) {
    assert.match(read(f), /In transit/,
      `${f} must not label a merely processing outbound payment as paid`);
  }
});

test('recently posted payouts stay under reconciliation because banks can return them later', () => {
  const payouts = read(PAYOUTS_LIB);
  assert.match(payouts, /RETURN_RECONCILIATION_WINDOW_DAYS\s*=\s*90/);
  assert.match(payouts, /\.eq\('status',\s*'paid'\)/);
  assert.match(payouts, /\.gte\('completed_at'/);
  assert.match(payouts, /\[\.\.\.\(processingResult\.data \?\? \[\]\), \.\.\.\(paidResult\.data \?\? \[\]\)\]/);
});

test('a bank return after posted restores the reservation exactly once', () => {
  const sql = read(RETURNED_PAYOUT_MIGRATION);
  const paidBranch = sql.slice(
    sql.indexOf("if v_payout.status = 'paid' then"),
    sql.indexOf("if v_payout.status = 'failed' then")
  );
  assert.match(paidBranch, /if p_succeeded then/);
  assert.match(paidBranch, /delete from referral_ledger[\s\S]*entry_type = 'payout'/);
  assert.match(paidBranch, /set status = 'failed'/);
  assert.match(sql, /if v_payout.status = 'failed' then[\s\S]*return not p_succeeded/);
  assert.match(sql, /pg_advisory_xact_lock/);
});

test('Global Payouts defaults to Stripe current preview version', () => {
  assert.match(read(GLOBAL_PAYOUTS), /2026-07-29\.preview/);
});

test('the owner dashboard separates eligible, in-transit, and completed payouts', () => {
  const page = read('monetization/web/app/admin/AdminReferrals.tsx');
  assert.match(page, />In transit</);
  assert.match(page, /Payout history/);
  assert.match(page, /Processing payouts remain visible/);
  assert.match(page, /approved_by_email/);
});

// ── Migration hygiene ────────────────────────────────────────────────────────

test('the migration is additive only and cannot trip the plan/plan_code drift', () => {
  const sql = read(MIGRATION);
  assert.doesNotMatch(sql, /alter table (licenses|subscriptions|profiles|plans)/i,
    'must not ALTER existing tables — schema.sql has drifted from the live database');
  assert.doesNotMatch(sql, /\bplan_code\b\s+text\s+.*references plans/i);
  assert.match(sql, /create table if not exists referral_codes/);
  assert.match(sql, /create table if not exists stripe_events/);
});

test('every referral table is service-role only', () => {
  const sql = read(MIGRATION);
  assert.match(sql, /revoke all on table[\s\S]*from anon, authenticated;/i,
    'browser roles must have direct table privileges revoked as defense in depth');
  for (const t of [
    'referral_codes', 'referral_attributions', 'referral_reservations', 'referral_ledger',
    'referral_payouts', 'referral_payout_accounts', 'stripe_events',
  ]) {
    assert.ok(new RegExp(`alter table ${t} enable row level security`).test(sql),
      `${t} must have RLS enabled`);
    assert.ok(new RegExp(`on ${t}\\s*\\n?\\s*for all to service_role`).test(sql),
      `${t} must be service-role only`);
  }
});

// ── Regression: blocking findings from the release audit ─────────────────────

test('a reserved processing payout that already has an outbound payment is reconciled, never resent', () => {
  const src = read(PAYOUTS_LIB);

  // The in-flight lookup must SELECT the column, or the guard below can never fire.
  assert.match(
    src,
    /\.select\('id, amount_cents, idempotency_key, stripe_recipient_id, stripe_payout_method_id, stripe_outbound_payment_id'\)/,
    'the resumed-payout lookup must select stripe_outbound_payment_id'
  );
  assert.match(src, /stripe_outbound_payment_id\?: string \| null;/,
    'ReservedPayout must carry the already-accepted outbound payment id');

  // reserve_global_referral_payout() does not return the column, so a resumed
  // reservation must read it back before deciding to send.
  assert.match(src, /reserved\.resumed && !reserved\.stripe_outbound_payment_id/);

  // And the guard must sit BEFORE the outbound payment is created.
  const guardAt    = src.indexOf('if (reserved.stripe_outbound_payment_id) {');
  const retrieveAt = src.indexOf('await retrieveGlobalOutboundPayment(outboundId)');
  const createAt   = src.indexOf('await createGlobalOutboundPayment(');
  assert.ok(guardAt > 0, 'an already-submitted payout must be detected before sending');
  assert.ok(retrieveAt > guardAt && retrieveAt < createAt,
    'an already-submitted payout must be retrieved and reconciled, not resent');
  assert.ok(guardAt < createAt,
    'the duplicate-send guard must precede createGlobalOutboundPayment');
});

test('finalizing an already-paid payout is idempotent and a null retry id is not an error', () => {
  const sql = read(PAYOUT_MIGRATION);
  const paidAt = sql.indexOf('if v_payout.status = ' + String.fromCharCode(39) + 'paid' + String.fromCharCode(39) + ' then');
  assert.ok(paidAt > 0);
  const branch = sql.slice(paidAt, paidAt + 700);

  assert.match(branch, /p_stripe_outbound_payment_id is null[\s\S]*return true;/,
    'a retry that names no outbound payment must not report a finalization failure');
  assert.match(branch, /is not distinct from p_stripe_outbound_payment_id/,
    'replaying the same outbound payment id must return true, not null');
  assert.doesNotMatch(branch, /return v_payout\.stripe_outbound_payment_id = p_stripe_outbound_payment_id;/,
    'a null comparison there yields NULL and surfaces as a false 502');
});

test('the tier migration is transactional and preflights incompatible data before mutating', () => {
  const sql = read(TIER_MIGRATION);

  const beginAt     = sql.indexOf('\nbegin;');
  const preflightAt = sql.indexOf('do $preflight$');
  const firstDdlAt  = sql.indexOf('alter table referral_attributions');
  assert.ok(beginAt > -1, 'the migration must open an explicit transaction');
  assert.ok(sql.trimEnd().endsWith('commit;'), 'the migration must commit as one unit');
  assert.ok(preflightAt > beginAt && preflightAt < firstDdlAt,
    'preflight must abort BEFORE any DDL or backfill runs');

  const preflight = sql.slice(preflightAt, firstDdlAt);
  assert.match(preflight, /referral_attributions_lifetime_only/);
  assert.match(preflight, /referral_reservations_lifetime_only/);
  assert.match(preflight, /uniq_referral_attribution_referred_email/);
  assert.match(preflight, /uniq_referral_attribution_referred_user/);
  assert.match(preflight, /uniq_referral_attribution_payment_intent/);
  assert.match(preflight, /hint =/, 'each preflight failure must say how to resolve it');
});

test('referral_reversal_intents is service-role only, like every other referral table', () => {
  const sql = read(TIER_MIGRATION);
  assert.match(sql, /alter table referral_reversal_intents enable row level security/);
  assert.match(sql, /on referral_reversal_intents for all to service_role/);
  assert.match(sql, /revoke all on table referral_reversal_intents from anon, authenticated;/,
    'browser roles must not hold direct PostgREST privileges on refund or dispute records');
});

test('an exhausted user scan fails closed instead of declaring a returning buyer new', () => {
  const src = read(REFERRALS_LIB);

  assert.match(src, /class ReferralUserLookupError extends Error/);

  const fnAt   = src.indexOf('export async function findUserIdByEmail');
  const fnBody = src.slice(fnAt, src.indexOf('export async function getUserEmail'));
  assert.match(fnBody, /throw new ReferralUserLookupError/,
    'hitting the 20k scan cap must raise, not return null');
  const capAt   = fnBody.indexOf('REFERRAL_USER_LOOKUP_EXHAUSTED');
  const throwAt = fnBody.indexOf('throw new ReferralUserLookupError', capAt);
  assert.ok(capAt > 0 && throwAt > capAt, 'the cap path must log and then fail closed');
  assert.doesNotMatch(
    fnBody.slice(capAt),
    /accounts without a match[\s\S]*?\);\s*\n\s*return null;/,
    'the cap path must not fall through to a null result'
  );

  // The caller must convert that into not-new, never into new.
  const buyerAt   = src.indexOf('export async function isNewBuyer');
  const buyerBody = src.slice(buyerAt, src.indexOf('Look up a user id by email'));
  assert.match(buyerBody, /err instanceof ReferralUserLookupError/);
  assert.match(buyerBody, /isNew: false, reason: 'user-lookup-unavailable'/,
    'an undecidable identity lookup must never read as a new buyer');
});

test('auth provider failures fail closed instead of awarding a referral', () => {
  const src = read(REFERRALS_LIB);
  const fnAt = src.indexOf('export async function findUserIdByEmail');
  const fnBody = src.slice(fnAt, src.indexOf('export async function getUserEmail'));

  assert.match(fnBody, /if \(error\) \{[\s\S]*throw new ReferralUserLookupError/,
    'a listUsers provider error must be undecidable, not user-absent');
  assert.match(fnBody, /catch \(err\) \{[\s\S]*throw new ReferralUserLookupError/,
    'a thrown auth/network error must fail closed');
  assert.doesNotMatch(fnBody, /catch(?: \([^)]*\))? \{\s*return null;/,
    'provider exceptions must never declare the buyer new');
});

test('the outbound payment status enum stays exactly what Stripe documents', () => {
  const sql = read(PAYOUT_MIGRATION);
  const api = read(GLOBAL_PAYOUTS);
  const payouts = read(PAYOUTS_LIB);

  assert.match(
    sql,
    /stripe_outbound_payment_status in \(\s*'processing', 'posted', 'failed', 'returned', 'canceled'\s*\)/,
    'the CHECK must mirror the documented Stripe outbound payment statuses'
  );
  assert.match(api, /'processing' \| 'posted' \| 'failed' \| 'returned' \| 'canceled'/);
  assert.match(payouts, /new Set\(\['failed', 'returned', 'canceled'\]\)/,
    'only failed, returned and canceled are terminal failures; posted is success');
});

test('both new referral migrations live in the sequence supabase db push applies', () => {
  for (const m of [TIER_MIGRATION, PAYOUT_MIGRATION]) {
    assert.ok(m.startsWith('supabase/migrations/'),
      m + ' must be in the root supabase/migrations sequence');
    assert.ok(fs.existsSync(path.join(ROOT, m)), m + ' is missing');
  }
  // No drifting duplicate copy may be left behind under monetization/supabase.
  for (const stale of [
    'monetization/supabase/20260812211500_tiered_referral_rewards.sql',
    'monetization/supabase/20260813100000_global_referral_payouts.sql',
  ]) {
    assert.ok(!fs.existsSync(path.join(ROOT, stale)),
      stale + ' is a duplicate canonical migration and must not exist');
  }
});

// ── Direct-bank-deposit UX: states, copy, and safe re-enrollment ─────────────

test('both surfaces use customer-facing "bank deposit" language, not internal payout jargon', () => {
  for (const f of [WEB_PANEL, DESKTOP_PANEL]) {
    const src = read(f);
    assert.match(src, /Connect bank securely/, `${f} must use the "Connect bank securely" label`);
    assert.match(src, /Finish bank setup/, `${f} must use the "Finish bank setup" label`);
    assert.match(src, /Bank deposit ready/, `${f} must use the "Bank deposit ready" label`);
    assert.match(src, /Bank deposit not connected/, `${f} must use the "Bank deposit not connected" label`);
    assert.match(src, /Bank setup incomplete/, `${f} must use the "Bank setup incomplete" label`);
    assert.doesNotMatch(src, /Set up payouts|Payout account (ready|not connected)|Secure payout setup incomplete/,
      `${f} must not still use the old payout-account wording`);
  }
});

test('both surfaces explain Stripe custody, one-time setup, and conditional automation before the bank redirect', () => {
  for (const f of [WEB_PANEL, DESKTOP_PANEL]) {
    const src = read(f);
    assert.match(src, /Stripe securely collects your bank details/i,
      `${f} must explain Stripe collects the bank details`);
    assert.match(src, /StatfloBot never\s*\n?\s*sees or stores your bank account or routing numbers/i,
      `${f} must state StatfloBot never sees or stores bank numbers`);
    assert.match(src, /Setup is normally one-time/i,
      `${f} must set the one-time-setup expectation`);
    assert.match(src, /automatic bank deposit each day after the 30-day hold/i,
      `${f} must explain when automatic payout checks begin`);
    // The explanation is gated on canConnectBank, so it disappears once the
    // account is ready — it must never render for an already-connected bank.
    const explainAt = src.indexOf('Stripe securely collects your bank details');
    const guardAt = src.lastIndexOf('canConnectBank &&', explainAt);
    assert.ok(guardAt > 0 && guardAt < explainAt,
      `${f} must gate the Stripe explanation on canConnectBank`);
  }
});

test('the three bank states are mutually exclusive and derived from payoutAccount, not a separate flag', () => {
  for (const f of [WEB_PANEL, DESKTOP_PANEL]) {
    const src = read(f);
    assert.match(src, /bankReady\s*=\s*!!payoutAccount\.payoutsEnabled/);
    assert.match(src, /bankNotStarted\s*=\s*!bankReady\s*&&\s*\(payoutAccount\.status\s*\?\?\s*'none'\)\s*===\s*'none'/,
      `${f} must treat a missing account row as "not started"`);
    assert.match(src, /bankIncomplete\s*=\s*!bankReady\s*&&\s*!bankNotStarted/,
      `${f} must treat any non-ready, non-none status ('created' or 'pending') as "incomplete"`);
  }
});

test('the web dashboard reads and clears the Stripe return query param exactly once', () => {
  const src = read(WEB_PANEL);
  assert.match(src, /params\.get\('referralPayout'\)/);
  assert.match(src, /status !== 'complete' && status !== 'refresh'\) return/,
    'only the two return states createOnboardingLink issues must be recognized');
  assert.match(src, /window\.history\.replaceState/,
    'the return param must be stripped so it cannot re-trigger the banner on refresh or back-nav');

  // The returnUrl/refreshUrl createOnboardingLink issues must match what the panel reads.
  const lib = read(PAYOUTS_LIB);
  assert.match(lib, /referralPayout=complete/);
  assert.match(lib, /referralPayout=refresh/);
});

test('the desktop panel refreshes on window focus since Stripe returns to the system browser, not the app', () => {
  const src = read(DESKTOP_PANEL);
  assert.match(src, /window\.addEventListener\('focus', onFocus\)/);
  assert.match(src, /document\.addEventListener\('visibilitychange', onVisible\)/);
  // And it must actually call load(), not just subscribe.
  assert.match(src, /const onFocus = \(\) => load\(\);/);
});

test('a fresh Stripe link is minted on every click, so an expired or already-used link is never reused', () => {
  const lib = read(PAYOUTS_LIB);
  // createGlobalRecipientLink is called unconditionally inside createOnboardingLink,
  // never gated behind "if no link was created yet" — so repeat clicks (including
  // one after the previous link expired or was used) always get a brand-new URL.
  const fnAt = lib.indexOf('export async function createOnboardingLink');
  const fn = lib.slice(fnAt);
  const recipientGateAt = fn.indexOf('if (!recipientId)');
  const linkCallAt = fn.indexOf('await createGlobalRecipientLink(');
  assert.ok(recipientGateAt > 0 && linkCallAt > recipientGateAt,
    'the recipient is created at most once, but the link call must sit outside that guard');
  const recipientGateBlockEnd = fn.indexOf('\n    }', recipientGateAt);
  assert.ok(linkCallAt > recipientGateBlockEnd,
    'createGlobalRecipientLink must run on every call, not only on first-time recipient creation');

  for (const f of [WEB_PANEL, DESKTOP_PANEL]) {
    assert.match(read(f), /A fresh, single-use Stripe link is minted on every click/,
      `${f} must document that repeat clicks never rely on a stale link`);
  }
});

test('bank setup failures return a friendly message, never a raw Stripe error string', () => {
  const lib = read(PAYOUTS_LIB);
  const route = read('monetization/web/app/api/referrals/connect/onboard/route.ts');
  assert.match(lib, /Could not start bank setup\. Please try again\./);
  assert.doesNotMatch(lib, /err\.message\}\`,\s*\n?\s*status:/,
    'the catch block must not interpolate the raw Stripe error message into the client-facing error');
  assert.match(route, /Bank setup is available to lifetime customers/);
});

test('the owner queue shows one plain-English next action per row', () => {
  const src = read('monetization/web/app/admin/AdminReferrals.tsx');
  assert.match(src, /function nextPayoutAction/);
  assert.match(src, /<th className="px-4 py-3">Next step<\/th>/);
  assert.match(src, /\{nextPayoutAction\(r, config\)\}/);

  // Exercise the real shipped ordering of blocking conditions directly, since
  // this file is TSX and can't be dynamically imported by this plain node:test suite.
  const fnAt = src.indexOf('function nextPayoutAction');
  const fnSrc = src.slice(fnAt, src.indexOf('\n}', fnAt) + 2);
  const nextPayoutAction = new Function(
    'row', 'config', 'money',
    fnSrc.replace('function nextPayoutAction(row: QueueRow, config: AdminData[\'config\']): string {', 'return (function (row, config) {')
         .replace(/\n\}$/, '\n})(row, config);')
  );
  const money = (c) => `$${(c / 100).toFixed(2)}`;
  const base = { isNegative: false, payoutsEnabled: true, connectStatus: 'complete', meetsThreshold: true };
  const cfg  = { thresholdCents: 1000, payoutsEnabled: true };

  assert.strictEqual(nextPayoutAction({ ...base, isNegative: true }, cfg, money), 'Review reversed balance');
  assert.strictEqual(nextPayoutAction({ ...base, payoutsEnabled: false, connectStatus: 'none' }, cfg, money), 'Waiting for bank connection');
  assert.strictEqual(nextPayoutAction({ ...base, payoutsEnabled: false, connectStatus: 'pending' }, cfg, money), 'Waiting for bank setup');
  assert.strictEqual(nextPayoutAction(base, { ...cfg, thresholdCents: null }, money), 'Set payout threshold');
  assert.strictEqual(nextPayoutAction(base, { ...cfg, payoutsEnabled: false }, money), 'Payout sending disabled');
  assert.strictEqual(nextPayoutAction({ ...base, meetsThreshold: false }, cfg, money), 'Waiting for $10.00');
  assert.strictEqual(nextPayoutAction(base, cfg, money), 'Ready for owner review');
});

test('bank setup is offered independently of reward eligibility, never gated on balance or threshold', () => {
  for (const f of [WEB_PANEL, DESKTOP_PANEL]) {
    const src = read(f);
    const gateAt = src.indexOf('canConnectBank =');
    const gateLine = src.slice(gateAt, src.indexOf('\n', gateAt));
    assert.doesNotMatch(gateLine, /balance|threshold|eligible/i,
      `${f} must not require reward eligibility before allowing bank setup`);
  }
});
