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
  assert.match(src, /!input\.planCode\?\.startsWith\('lifetime'\)/);
  assert.match(src, /reason:\s*'not-lifetime'/);
});

test('the database rejects a non-lifetime attribution row', () => {
  const sql = read(MIGRATION);
  assert.match(sql, /constraint referral_attributions_lifetime_only\s+check \(plan_code like 'lifetime%'\)/);
});

test('the webhook only accrues on mode=payment lifetime purchases', () => {
  const src = read(WEBHOOK);
  const block = src.slice(src.indexOf('Referral accrual'));
  assert.match(block, /session\.mode === 'payment'/);
  assert.match(block, /licensePlan === 'lifetime'/);
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
  // The only writers of referral_attributions are accrueReferral (keyed on the
  // session id that already carried the referrer) and nothing else.
  const lib = read(REFERRALS_LIB);
  const writers = (lib.match(/from\('referral_attributions'\)\s*\n?\s*\.insert/g) ?? []).length;
  assert.strictEqual(writers, 1, 'exactly one insert path into referral_attributions');

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
  assert.match(src, /ledgerErr\.code === '23505'[\s\S]{0,200}reason:\s*'duplicate'/);
  assert.match(src, /error\.code === '23505'[\s\S]{0,200}reason:\s*'duplicate'/);
});

// ── 30-day hold ──────────────────────────────────────────────────────────────

test('the hold is 30 days and the accrual is $10.00', () => {
  const src = read(REFERRALS_LIB);
  assert.match(src, /REFERRAL_ACCRUAL_CENTS\s*=\s*1000\b/);
  assert.match(src, /REFERRAL_HOLD_DAYS\s*=\s*30\b/);
  assert.match(src, /REFERRAL_HOLD_DAYS \* 86_400_000/);
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
  assert.match(fn, /entry_type:\s*'reversal'/);
  assert.match(fn, /amount_cents:\s*-REFERRAL_ACCRUAL_CENTS/);
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

test('payout execution is feature-flagged closed and the threshold cannot be lowered', () => {
  const src = read(REFERRALS_LIB);
  assert.match(src, /process\.env\.REFERRAL_PAYOUTS_ENABLED === 'true'/,
    'must default to disabled — only the exact string "true" enables it');
  assert.match(src, /REFERRAL_PAYOUT_THRESHOLD_CENTS/);

  // The owner settled the minimum at $10.00 (one earned reward), so unset now
  // means that floor rather than "unconfigured". What must stay impossible is
  // an env var LOWERING it — that would let a payout go out below one reward.
  assert.match(src, /if \(!raw\) return REFERRAL_ACCRUAL_CENTS/,
    'unset must fall back to the $10.00 floor, not to zero or null');
  assert.match(src, /parsed < REFERRAL_ACCRUAL_CENTS\) return null/,
    'an env value below one reward must fail closed, not silently apply');
});

test('preflight blocks payouts below threshold, without a bank, or when negative', () => {
  const src = read(PAYOUTS_LIB);
  for (const reason of [
    'payouts-disabled',
    'threshold-not-configured',
    'below-threshold',
    'no-connect-account',
    'payouts-not-enabled-on-account',
    'negative-balance',
  ]) {
    assert.ok(src.includes(`'${reason}'`), `preflight must handle ${reason}`);
  }
});

test('there is no automatic payout path anywhere', () => {
  // executeApprovedPayout must only ever be reached through the admin route.
  const callers = [WEBHOOK, LICENSE_LIB, REFERRALS_LIB,
    'monetization/web/app/api/referrals/summary/route.ts',
    'monetization/web/app/api/referrals/code/route.ts'];
  for (const f of callers) {
    assert.doesNotMatch(read(f), /executeApprovedPayout/,
      `${f} must not be able to move money`);
  }
  assert.match(read(ADMIN_PAYOUT), /executeApprovedPayout/);
});

test('transfers carry an idempotency key and debit the ledger before sending', () => {
  const src = read(PAYOUTS_LIB);
  assert.match(src, /idempotencyKey:\s*payout\.idempotency_key/);

  // Anchor on the actual call, not the doc comment that also names it.
  const debitAt    = src.indexOf("entry_type:       'payout'");
  const transferAt = src.indexOf('await stripe.transfers.create(');
  assert.ok(debitAt > 0, 'expected a payout ledger debit');
  assert.ok(transferAt > 0, 'expected a transfers.create call');
  assert.ok(debitAt < transferAt,
    'the balance must be debited BEFORE the transfer, so a crash cannot pay twice');
});

test('a failed transfer restores the balance and reports insufficient funds', () => {
  const src = read(PAYOUTS_LIB);
  assert.match(src, /insufficient\|balance_insufficient/);
  assert.match(src, /no money moved/);
  assert.match(src, /status:\s*'failed'/);
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
  assert.match(read(REFERRALS_LIB), /TERMS_VERSION\s*=\s*'2026-08-11'/);
  assert.match(read(TERMS), /Last updated: August 11, 2026/);
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
  assert.match(sql, /create table if not exists referral_reservations/);
  assert.match(sql, /constraint referral_reservations_lifetime_only check \(plan_code like 'lifetime%'\)/);
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
const base = { reservations: [], attributions: [], accruals: [], reversedAttributionIds: [], paidCents: 0, accrualCents: 1000, now: NOW };

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
    accruals:     [{ attributionId: 'a1', eligibleAt: iso(29 * DAY) }],
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
      { attributionId: 'held',  eligibleAt: iso(25 * DAY)  },
      { attributionId: 'ready', eligibleAt: iso(-10 * DAY) },
      { attributionId: 'sent',  eligibleAt: iso(-60 * DAY) },
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
    accruals:               [{ attributionId: 'a1', eligibleAt: iso(-30 * DAY) }],
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
      { attributionId: 'a1', eligibleAt: iso(-60 * DAY) },
      { attributionId: 'a2', eligibleAt: iso(-50 * DAY) },
      { attributionId: 'a3', eligibleAt: iso(-40 * DAY) },
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

test('neither panel promises an automatic payout', () => {
  for (const f of [WEB_PANEL, DESKTOP_PANEL]) {
    const src = read(f);
    assert.match(src, /reviewed and approved by hand|sent manually after review/,
      `${f} must state that payouts are approved by hand`);
    assert.match(src, /payoutsConfigured === false/,
      `${f} must soften the copy when money movement is flagged off`);
    for (const forbidden of [/paid out automatically/i, /automatic(ally)? (transfer|deposit)/i]) {
      assert.doesNotMatch(readCode(f), forbidden,
        `${f} must not promise automation that does not exist`);
    }
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

  // Guard 1: an in-flight payout blocks a second approval outright.
  assert.match(src, /\.eq\('status', 'processing'\)/);
  assert.match(src, /REFERRAL_PAYOUT_ALREADY_IN_FLIGHT/);

  // Guard 2: re-read after the debit catches anything that slipped past guard 1.
  const debitAt    = src.indexOf("entry_type:       'payout'");
  const recheckAt  = src.indexOf('const postDebit = await getReferralBalance');
  const transferAt = src.indexOf('await stripe.transfers.create(');
  assert.ok(debitAt > 0 && recheckAt > debitAt,
    'the re-read must happen after the debit is visible in the ledger');
  assert.ok(recheckAt < transferAt,
    'the race must be detected BEFORE any money moves');
  assert.match(src, /REFERRAL_PAYOUT_RACE_ABORTED/);

  // And the aborted attempt is rolled back, not left as a phantom debit.
  const abortBlock = src.slice(recheckAt, transferAt);
  assert.match(abortBlock, /from\('referral_ledger'\)\.delete\(\)/);
  assert.match(abortBlock, /status: 'canceled'/);
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
