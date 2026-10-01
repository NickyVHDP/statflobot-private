/**
 * tests/referral-auto-payouts.test.js
 *
 * Automatic referral payouts.
 *
 * The decision rules live in monetization/web/lib/referralAutoPayoutPolicy.ts,
 * which has no imports, so Node's type stripping loads it directly and the
 * assertions below exercise the REAL shipped guards — not a re-implementation.
 * The orchestration, migration and route wiring are checked structurally, in the
 * style of tests/referrals.test.js.
 *
 * What these do NOT prove: Stripe's runtime behaviour. End-to-end verification
 * in Stripe test mode is still required before REFERRAL_AUTO_PAYOUTS_ENABLED is
 * ever set to true.
 */

const { test } = require('node:test');
const assert   = require('node:assert');
const fs       = require('node:fs');
const path     = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const readCode = (p) =>
  read(p)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');

const POLICY      = 'monetization/web/lib/referralAutoPayoutPolicy.ts';
const AUTO        = 'monetization/web/lib/referralAutoPayouts.ts';
const NOTICES     = 'monetization/web/lib/referralOwnerNotices.ts';
const CRON_ROUTE  = 'monetization/web/app/api/cron/referral-payouts/route.ts';
const RUNS_SQL    = 'supabase/migrations/20260813220000_automatic_referral_payout_runs.sql';
const NOTICES_SQL = 'supabase/migrations/20260814093000_referral_auto_payout_notices.sql';
const EARLY_PAYOUT_SQL = 'supabase/migrations/20260930120000_referral_early_payout_approvals.sql';
const PAYOUTS_LIB = 'monetization/web/lib/referralPayouts.ts';
const REFERRALS   = 'monetization/web/lib/referrals.ts';
const ADMIN_AUDIT = 'monetization/web/app/api/admin/referrals/route.ts';
const ADMIN_PAYOUT = 'monetization/web/app/api/admin/referrals/payout/route.ts';
const ADMIN_UI    = 'monetization/web/app/admin/AdminReferrals.tsx';
const VERCEL      = 'monetization/web/vercel.json';

const POLICY_MOD = new URL(`../${POLICY}`, `file://${__filename}`).href;
const loadPolicy = () => import(POLICY_MOD);

const DAY = 86_400_000;

/** A candidate that passes every guard, so each test can break exactly one. */
const okLimits = {
  reserveCents: 2500,
  recipientDailyCapCents: 10_000,
  globalDailyCapCents: 25_000,
  taxReviewCeilingCents: 150_000,
};
const payable = {
  manualPayoutsEnabled: true,
  autoPayoutsEnabled: true,
  thresholdCents: 1000,
  limits: okLimits,
  eligibleCents: 2500,
  hasRealLifetimeEntitlement: true,
  bankReady: true,
  autoPayoutsBlocked: false,
  payoutInFlight: false,
  recipientPaidTodayCents: 0,
  globalPaidTodayCents: 0,
  recipientPaidThisYearCents: 0,
};

// ── Fail-closed configuration ────────────────────────────────────────────────

test('a missing or malformed money limit fails closed instead of taking a default', async () => {
  const { readAutoPayoutLimits, parseRequiredCents, DESIRED_RESERVE_CENTS } = await loadPolicy();

  // The desired values are documented...
  assert.strictEqual(DESIRED_RESERVE_CENTS, 2500);

  // ...and are never substituted for an absent setting.
  const missing = readAutoPayoutLimits({});
  assert.strictEqual(missing.limits, null, 'unset limits must not fall back to a default');
  assert.deepStrictEqual(missing.invalid.sort(), [
    'REFERRAL_AUTO_PAYOUT_GLOBAL_DAILY_CAP_CENTS',
    'REFERRAL_AUTO_PAYOUT_RECIPIENT_DAILY_CAP_CENTS',
    'REFERRAL_AUTO_PAYOUT_RESERVE_CENTS',
    'REFERRAL_AUTO_TAX_REVIEW_CEILING_CENTS',
  ]);

  for (const bad of ['', ' ', 'abc', '25.00', '2.5e3', '-100', '+100', '0x10', '1,000']) {
    assert.strictEqual(parseRequiredCents(bad, 0), null, `"${bad}" must not parse as cents`);
  }
  assert.strictEqual(parseRequiredCents('2500', 0), 2500);
  assert.strictEqual(parseRequiredCents('0', 0), 0, 'a deliberate zero reserve is allowed');
  assert.strictEqual(parseRequiredCents('500', 1000), null, 'a below-minimum cap fails closed');
});

test('one bad limit invalidates the whole set', async () => {
  const { readAutoPayoutLimits } = await loadPolicy();

  const result = readAutoPayoutLimits({
    REFERRAL_AUTO_PAYOUT_RESERVE_CENTS: '2500',
    REFERRAL_AUTO_PAYOUT_RECIPIENT_DAILY_CAP_CENTS: '10000',
    REFERRAL_AUTO_PAYOUT_GLOBAL_DAILY_CAP_CENTS: '25000',
    REFERRAL_AUTO_TAX_REVIEW_CEILING_CENTS: 'fifteen hundred',
  });
  assert.strictEqual(result.limits, null,
    'a valid reserve must not license a run with an unusable ceiling');
  assert.deepStrictEqual(result.invalid, ['REFERRAL_AUTO_TAX_REVIEW_CEILING_CENTS']);
});

test('a fully configured environment yields exactly the owner\'s numbers', async () => {
  const { readAutoPayoutLimits } = await loadPolicy();

  const { limits, invalid } = readAutoPayoutLimits({
    REFERRAL_AUTO_PAYOUT_RESERVE_CENTS: '2500',
    REFERRAL_AUTO_PAYOUT_RECIPIENT_DAILY_CAP_CENTS: '10000',
    REFERRAL_AUTO_PAYOUT_GLOBAL_DAILY_CAP_CENTS: '25000',
    REFERRAL_AUTO_TAX_REVIEW_CEILING_CENTS: '150000',
  });
  assert.deepStrictEqual(invalid, []);
  assert.deepStrictEqual(limits, okLimits);
});

// ── Guards ───────────────────────────────────────────────────────────────────

test('a fully eligible candidate is approved for its exact matured balance', async () => {
  const { evaluateAutoPayoutGuards } = await loadPolicy();

  const result = evaluateAutoPayoutGuards(payable);
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.amountCents, 2500, 'the payout is the matured balance, never more');
});

test('every guard refuses on its own, in the owner\'s stated order', async () => {
  const { evaluateAutoPayoutGuards } = await loadPolicy();

  const cases = [
    ['limits-not-configured',   { limits: null }],
    ['manual-payouts-disabled', { manualPayoutsEnabled: false }],
    ['auto-payouts-disabled',   { autoPayoutsEnabled: false }],
    ['threshold-not-configured',{ thresholdCents: null }],
    ['threshold-not-configured',{ thresholdCents: 999 }],
    ['auto-payouts-blocked',    { autoPayoutsBlocked: true }],
    ['payout-in-flight',        { payoutInFlight: true }],
    ['not-lifetime',            { hasRealLifetimeEntitlement: false }],
    ['negative-balance',        { eligibleCents: -500 }],
    ['no-matured-balance',      { eligibleCents: 0 }],
    ['below-threshold',         { eligibleCents: 999 }],
    ['bank-not-ready',          { bankReady: false }],
  ];

  for (const [reason, override] of cases) {
    const result = evaluateAutoPayoutGuards({ ...payable, ...override });
    assert.strictEqual(result.ok, false, `${reason} must refuse`);
    assert.strictEqual(result.reason, reason);
    assert.ok(result.detail.length > 10, `${reason} must explain itself to the owner`);
  }
});

test('the master manual flag outranks the automatic flag', async () => {
  const { evaluateAutoPayoutGuards } = await loadPolicy();

  // Turning automation on can never substitute for the money-movement master
  // switch: both are required, and the master one is reported first.
  const result = evaluateAutoPayoutGuards({
    ...payable, manualPayoutsEnabled: false, autoPayoutsEnabled: true,
  });
  assert.strictEqual(result.reason, 'manual-payouts-disabled');
});

// ── Caps ─────────────────────────────────────────────────────────────────────

test('the per-recipient daily cap refuses rather than paying a part of the balance', async () => {
  const { evaluateAutoPayoutGuards } = await loadPolicy();

  const atCap = evaluateAutoPayoutGuards({
    ...payable, eligibleCents: 2500, recipientPaidTodayCents: 8000,
  });
  assert.strictEqual(atCap.ok, false);
  assert.strictEqual(atCap.reason, 'recipient-daily-cap');
  assert.match(atCap.detail, /\$100\.00/, 'the refusal names the cap');

  // Exactly at the cap is still allowed; only passing it is refused.
  const exactly = evaluateAutoPayoutGuards({
    ...payable, eligibleCents: 2000, recipientPaidTodayCents: 8000,
  });
  assert.strictEqual(exactly.ok, true);
  assert.strictEqual(exactly.amountCents, 2000);
});

test('the global daily cap stops the run\'s total, not just one recipient', async () => {
  const { evaluateAutoPayoutGuards } = await loadPolicy();

  const blocked = evaluateAutoPayoutGuards({
    ...payable, eligibleCents: 2500, globalPaidTodayCents: 24_000,
  });
  assert.strictEqual(blocked.reason, 'global-daily-cap');

  // A recipient well under their own cap is still stopped by the global one,
  // which is the whole point of having both.
  assert.strictEqual(blocked.ok, false);
  assert.strictEqual(
    evaluateAutoPayoutGuards({ ...payable, eligibleCents: 1000, globalPaidTodayCents: 24_000 }).ok,
    true
  );
});

test('multiple recipients in one run consume the same global cap', async () => {
  const { evaluateAutoPayoutGuards } = await loadPolicy();

  // Simulates the orchestrator's running total: three $100 recipients against a
  // $250 daily ceiling — the third is refused, not trimmed.
  let globalPaidTodayCents = 0;
  const outcomes = [];
  for (let i = 0; i < 3; i++) {
    const result = evaluateAutoPayoutGuards({
      ...payable, eligibleCents: 10_000, globalPaidTodayCents,
    });
    outcomes.push(result.ok ? 'paid' : result.reason);
    if (result.ok) globalPaidTodayCents += result.amountCents;
  }
  assert.deepStrictEqual(outcomes, ['paid', 'paid', 'global-daily-cap']);
  assert.strictEqual(globalPaidTodayCents, 20_000);
});

test('the run reserves the global cap as it accepts candidates, not after paying them', () => {
  const src = read(AUTO);

  // Candidates are evaluated in one pass and paid in a later one. If the guard
  // pass compared every recipient against the same starting total, three
  // recipients would each clear a $250 cap independently and then pay $300.
  assert.match(src, /let plannedGlobalCents = 0;/);
  assert.match(src, /globalPaidTodayCents: globalPaidTodayCents \+ plannedGlobalCents/,
    'each accepted candidate must spend the shared daily cap immediately');
  const reserveAt = src.indexOf('plannedGlobalCents += guards.amountCents');
  const pushAt = src.indexOf('candidates.push({');
  assert.ok(reserveAt > 0 && reserveAt < pushAt,
    'the cap is spent as the candidate is accepted');
});

test('the annual tax-review ceiling stops AT the ceiling, not after passing it', async () => {
  const { evaluateAutoPayoutGuards } = await loadPolicy();

  const reaching = evaluateAutoPayoutGuards({
    ...payable, eligibleCents: 2500, recipientPaidThisYearCents: 147_500,
  });
  assert.strictEqual(reaching.ok, false);
  assert.strictEqual(reaching.reason, 'tax-review-ceiling');

  const under = evaluateAutoPayoutGuards({
    ...payable, eligibleCents: 2400, recipientPaidThisYearCents: 147_500,
  });
  assert.strictEqual(under.ok, true);
});

// ── Funding: fee + reserve arithmetic ────────────────────────────────────────

test('required funds are reward + $1.50 bank fee + configured reserve', async () => {
  const { evaluateFunding, REFERRAL_AUTO_PAYOUT_FEE_CENTS } = await loadPolicy();

  assert.strictEqual(REFERRAL_AUTO_PAYOUT_FEE_CENTS, 150);

  const exact = evaluateFunding({ amountCents: 2500, reserveCents: 2500, availableCents: 5150 });
  assert.strictEqual(exact.ok, true);
  assert.strictEqual(exact.requiredCents, 5150, '2500 reward + 150 fee + 2500 reserve');

  const short = evaluateFunding({ amountCents: 2500, reserveCents: 2500, availableCents: 5149 });
  assert.strictEqual(short.ok, false);
  assert.strictEqual(short.reason, 'insufficient-funds');
  assert.strictEqual(short.shortfallCents, 1, 'one cent short is short');
  assert.match(short.detail, /Add \$0\.01/, 'the owner is told the exact amount to add');
});

test('a balance that covers the reward but not the reserve is still insufficient', async () => {
  const { evaluateFunding } = await loadPolicy();

  const result = evaluateFunding({ amountCents: 2500, reserveCents: 2500, availableCents: 2600 });
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.shortfallCents, 2550);
  assert.strictEqual(result.requiredCents, 5150);
});

test('an unreadable Financial Account balance is treated as no money at all', async () => {
  const { evaluateFunding } = await loadPolicy();

  const result = evaluateFunding({ amountCents: 2500, reserveCents: 2500, availableCents: null });
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.reason, 'financial-account-unavailable');
  assert.strictEqual(result.shortfallCents, result.requiredCents,
    'an unknown balance must never be assumed to be partly funded');
});

test('a zero reserve is honoured when the owner explicitly configures it', async () => {
  const { evaluateFunding } = await loadPolicy();

  const result = evaluateFunding({ amountCents: 1000, reserveCents: 0, availableCents: 1150 });
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.requiredCents, 1150);
});

test('the composed evaluation refuses on guards before it ever looks at funding', async () => {
  const { evaluateAutoPayoutCandidate } = await loadPolicy();

  // A bank-incomplete recipient must be refused without a funding verdict, so
  // the orchestrator can skip the Stripe balance call entirely.
  const result = evaluateAutoPayoutCandidate({
    ...payable, bankReady: false, availableCents: 1_000_000,
  });
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.reason, 'bank-not-ready');
  assert.strictEqual(result.shortfallCents, undefined);
});

// ── Reminders ────────────────────────────────────────────────────────────────

test('funding reminders fire at 7 days and 1 day, and nowhere else', async () => {
  const { dueFundingReminder, daysUntil } = await loadPolicy();

  assert.strictEqual(dueFundingReminder(30), null);
  assert.strictEqual(dueFundingReminder(8),  null);
  assert.strictEqual(dueFundingReminder(7),  'seven-day');
  assert.strictEqual(dueFundingReminder(2),  'seven-day');
  assert.strictEqual(dueFundingReminder(1),  'one-day');
  assert.strictEqual(dueFundingReminder(0),  'one-day');
  assert.strictEqual(dueFundingReminder(-1), null, 'a matured reward is not a reminder');

  const now = Date.parse('2026-08-13T12:00:00Z');
  assert.strictEqual(daysUntil(now + 7 * DAY, now), 7);
  assert.strictEqual(daysUntil(now + 6.5 * DAY, now), 7, 'partial days round up, never down');
});

test('the next scheduled run is always in the future and matches vercel.json', async () => {
  const { nextDailyRunAt } = await loadPolicy();

  const cron = JSON.parse(read(VERCEL)).crons[0];
  const [minute, hour] = cron.schedule.split(' ');
  assert.match(cron.schedule, /^\d+ \d+ \* \* \*$/,
    'Vercel Hobby supports a once-daily schedule only');
  assert.match(cron.path, /^\/api\/cron\/referral-payouts$/);

  const auto = read(AUTO);
  assert.ok(auto.includes(`AUTO_PAYOUT_RUN_UTC_HOUR = ${Number(hour)}`),
    'the dashboard clock must match the deployed cron hour');
  assert.ok(auto.includes(`AUTO_PAYOUT_RUN_UTC_MINUTE = ${Number(minute)}`),
    'the dashboard clock must match the deployed cron minute');

  const now = Date.parse('2026-08-13T18:00:00Z');
  const next = Date.parse(nextDailyRunAt(now, Number(hour), Number(minute)));
  assert.ok(next > now, 'a time already past today must roll to tomorrow');
  assert.ok(next - now <= DAY);
});

// ── Orchestration wiring ─────────────────────────────────────────────────────

test('the run refuses before Stripe when configuration is incomplete', async () => {
  const src = read(AUTO);

  const configAt = src.indexOf('if (!config.limits || config.invalidSettings.length > 0)');
  const leaseAt  = src.indexOf("rpc('claim_referral_auto_payout_run'");
  const stripeAt = src.indexOf('retrieveGlobalFinancialAccount(');
  assert.ok(configAt > 0, 'the run must check its limits');
  assert.ok(configAt < leaseAt && configAt < stripeAt,
    'an unusable limit must stop the run before the lease and before any Stripe call');
  assert.match(src, /noticeLimitsNotConfigured/);
});

test('a run with nothing to pay makes no Stripe balance call at all', () => {
  const src = read(AUTO);
  assert.match(src, /if \(candidates\.length > 0 \|\| upcoming\.length > 0\) \{[\s\S]{0,400}retrieveGlobalFinancialAccount/,
    'the Financial Account is read only when a decision depends on it');
});

test('automatic payouts reuse the manual reservation and finalization primitives', () => {
  const src = read(AUTO);
  const payouts = read(PAYOUTS_LIB);

  assert.match(src, /executeApprovedPayout\(\{[\s\S]{0,200}maximumAmountCents/,
    'the automatic path caps the reservation at the preflighted amount');
  assert.match(payouts, /reserve_global_referral_payout/);
  assert.match(payouts, /finalize_global_referral_payout/);
  assert.match(payouts, /record_global_referral_payout_submission/);

  // No second money-moving primitive may be introduced for automation.
  assert.doesNotMatch(readCode(AUTO), /createGlobalOutboundPayment/,
    'automation must not submit its own outbound payment');
});

test('a balance that grows between the funding check and the reservation is not paid', () => {
  const src = read(PAYOUTS_LIB);
  assert.match(src, /reserved\.amount_cents > opts\.maximumAmountCents/);
  assert.match(src, /Automatic payout amount changed after preflight/);
  // The guard must not fire once Stripe already holds the payment.
  assert.match(src, /reserved\.amount_cents > opts\.maximumAmountCents &&\s*\n?\s*!reserved\.stripe_outbound_payment_id/);
});

test('duplicate cron delivery cannot pay twice', () => {
  const src = read(AUTO);
  const sql = read(RUNS_SQL);

  assert.match(src, /claim_referral_auto_payout_run/);
  assert.match(src, /already-run-or-running/);
  assert.match(sql, /run_date\s+date primary key/);
  assert.match(sql, /on conflict \(run_date\) do update/);
  assert.match(sql, /lease_expires_at < now\(\)/,
    'only an expired lease may be taken over');

  // Second line of defence: the per-referrer reservation is itself serialized
  // and returns the in-flight payout instead of creating a second one.
  assert.match(read('supabase/migrations/20260813100000_global_referral_payouts.sql'),
    /pg_advisory_xact_lock/);
});

test('a failed or returned automatic payout pauses that recipient exactly once', () => {
  const src = read(AUTO);
  const sql = read(NOTICES_SQL);

  assert.match(src, /block_referral_auto_payouts_for_payout/);
  assert.match(src, /\.eq\('auto_block_applied', false\)/,
    'only failures that have not already been handled may block');
  assert.match(src, /autoPayoutsBlocked: !!account\?\.auto_payouts_blocked_at/,
    'a paused recipient must be refused by the guards');

  assert.match(sql, /if v_payout\.auto_block_applied then return false; end if;/);
  assert.match(sql, /if v_payout\.approved_by_email is distinct from p_auto_approver then return false; end if;/,
    'a hand-approved failure must never disable automation');
  assert.match(sql, /if v_payout\.status <> 'failed' then return false; end if;/);
  assert.match(sql, /update referral_payouts set auto_block_applied = true/);

  // Only the owner may resume, and resuming pays nothing by itself.
  assert.match(read(ADMIN_PAYOUT), /case 'clear-auto-block'/);
  const clearBlock = read(ADMIN_PAYOUT).slice(read(ADMIN_PAYOUT).indexOf("case 'clear-auto-block'"));
  assert.match(clearBlock, /isOwnerEmail\(user\.email\)[\s\S]{0,600}clear_referral_auto_payout_block/,
    'resuming automation is an owner decision, not an admin one');
});

test('reconciliation of processing, posted, failed and returned payouts still runs', () => {
  const src = read(AUTO);
  const reconcileAt = src.indexOf('await reconcileProcessingPayouts()');
  const payAt = src.indexOf('await executeApprovedPayout(');
  assert.ok(reconcileAt > 0 && reconcileAt < payAt,
    'in-flight money is settled before anything new is sent');
  assert.match(read(PAYOUTS_LIB), /RETURN_RECONCILIATION_WINDOW_DAYS/);
});

// ── Owner notifications ──────────────────────────────────────────────────────

test('an accrued reward tells the owner the amount, tier and eligibility date', () => {
  const src = read(REFERRALS);

  const accrualAt = src.indexOf('export async function accrueReferral');
  const noticeAt  = src.indexOf('noticeRewardRecorded', accrualAt);
  assert.ok(noticeAt > accrualAt, 'accrueReferral must notify the owner');
  assert.match(src.slice(accrualAt), /rewardCents:\s*result\.reward_cents/);
  assert.match(src.slice(accrualAt), /rewardTierCents:\s*result\.reward_tier_cents/);
  assert.match(src.slice(accrualAt), /eligibleAt,/);

  // The notice must never be able to fail a webhook or a guest reconciliation.
  assert.match(src.slice(accrualAt), /try \{[\s\S]{0,600}REFERRAL_ACCRUAL_NOTICE_FAILED/);

  const notices = read(NOTICES);
  assert.match(notices, /noticeKey: `reward-recorded:\$\{input\.attributionId\}`/);
  assert.match(notices, /minIntervalHours: null/, 'a reward is announced exactly once');
  assert.match(notices, /AUTO_PAYOUT_FUNDING_WINDOW_DAYS\}-day hold/,
    'the owner is told how long they have to fund the account');
});

test('owner notices are deduplicated, and a changed state always sends', () => {
  const sql = read(NOTICES_SQL);

  assert.match(sql, /notice_key\s+text\s+primary key/);
  assert.match(sql, /on conflict \(notice_key\) do nothing/);
  assert.match(sql, /if v_existing\.payload is not distinct from coalesce\(p_payload, '\{\}'::jsonb\) then/,
    'an unchanged state waits; a changed state must send immediately');
  assert.match(sql, /if p_min_interval is null then return false; end if;/,
    'a once-only notice must never repeat');
  assert.match(sql, /if v_existing\.last_sent_at > now\(\) - p_min_interval then return false; end if;/);

  const notices = read(NOTICES);
  assert.match(notices, /OWNER_NOTICE_REMINDER_HOURS/);
  assert.match(notices, /payload: \{ shortfallCents: input\.shortfallCents, amountCents: input\.amountCents \}/,
    'the shortfall is part of the dedupe state, so a new amount re-alerts');
});

test('a shortfall notice states the exact amount to add and never claims money moved', () => {
  const notices = read(NOTICES);

  const waiting = notices.slice(
    notices.indexOf('export function noticeAwaitingFunding'),
    notices.indexOf('export function noticeBankNotReady')
  );
  assert.match(waiting, /action: `Add \$\{?/, 'the action is the exact shortfall');
  assert.match(waiting, /formatCents\(input\.shortfallCents\)/);
  assert.match(waiting, /The payout was not attempted/);
  assert.doesNotMatch(waiting, /transfer|top ?up|pull/i,
    'the owner must never be told funds were moved for them');
});

test('7-day and 1-day reminders are sent once each and only when funding is short', () => {
  const src = read(AUTO);
  const notices = read(NOTICES);

  assert.match(src, /const reminder = dueFundingReminder\(/);
  assert.match(src, /if \(funding\.ok\) continue;/,
    'a reward that is already funded generates no reminder');
  assert.match(notices, /noticeKey: `funding-reminder:\$\{input\.reminder\}:\$\{input\.attributionId\}`/);
  assert.match(notices, /kind: 'funding-reminder'/);

  const reminder = notices.slice(
    notices.indexOf('export function noticeFundingReminder'),
    notices.indexOf('export function noticeAwaitingFunding')
  );
  assert.match(reminder, /minIntervalHours: null/, 'each reminder fires once per reward');
});

test('owner email cannot be sent from a developer machine', () => {
  const src = read(NOTICES);
  assert.match(src, /process\.env\.NODE_ENV !== 'production'/);
  assert.match(src, /REFERRAL_OWNER_NOTICE_MODE/, 'production needs a kill switch');
  assert.match(src, /if \(!process\.env\.RESEND_API_KEY\) return 'dry-run'/);
  assert.match(src, /idempotencyKey: providerIdempotencyKey/,
    'a retried send must collapse into one email');
});

test('a notification failure can never fail a payout run', () => {
  const src = read(NOTICES);
  const fn = src.slice(src.indexOf('export async function sendOwnerNotice'),
                       src.indexOf('const dateLabel'));
  assert.match(fn, /try \{/);
  assert.match(fn, /catch \(err: any\) \{[\s\S]{0,200}return 'failed'/);
  assert.doesNotMatch(fn, /throw /, 'sendOwnerNotice must never throw');
});

// ── Cron endpoint ────────────────────────────────────────────────────────────

test('the cron endpoint is CRON_SECRET protected and fails closed when unset', () => {
  const src = read(CRON_ROUTE);

  assert.match(src, /process\.env\.CRON_SECRET/);
  assert.match(src, /if \(!secret\)[\s\S]{0,200}return false/,
    'an unset secret must reject every request');
  assert.match(src, /timingSafeEqual/);
  assert.match(src, /presented\.length === expected\.length/,
    'timingSafeEqual throws on unequal lengths');
  assert.match(src, /status: 401/);

  // The response must not narrate internals to a secret holder.
  assert.match(src, /Automatic payout run failed closed\./);
  assert.doesNotMatch(readCode(CRON_ROUTE), /err\?\.message[^)]*\}, \{ status: 500/);
});

// ── Owner dashboard ──────────────────────────────────────────────────────────

test('the owner dashboard shows the switch, next run, limits, balance and waiting reasons', () => {
  const ui = read(ADMIN_UI);
  const api = read(ADMIN_AUDIT);

  assert.match(ui, /Automatic bank payouts/);
  assert.match(ui, /config\.automaticPayoutsEnabled \? 'Enabled' : 'Disabled'/);
  assert.match(ui, /Next scheduled run/);
  assert.match(ui, /Protected reserve/);
  assert.match(ui, /Daily safety caps/);
  assert.match(ui, /Available to pay/);
  assert.match(ui, /Annual tax-review ceiling/);
  assert.match(ui, /automaticSettingsInvalid\.length > 0/,
    'an unusable limit must be shown as a hard stop, not a silent default');
  assert.match(ui, /row\.automaticNextStep/,
    'each row shows why it is or is not scheduled');
  assert.match(ui, /Resume auto/);

  assert.match(api, /nextAutomaticRunAt: nextDailyRunAt\(/);
  assert.match(api, /annualPaidCents/);
  assert.match(api, /autoPayoutsBlocked:/);
  assert.match(api, /reserveCents,\s*\/\/ null → not configured/);

  // A null limit must render as "not set", never as a number the owner did not
  // choose — the UI is the last place a phantom default could appear.
  assert.match(ui, /config\.reserveCents === null \? 'not set'/);
});

test('the manual owner payout path is preserved and independent of automation', () => {
  const route = read(ADMIN_PAYOUT);

  assert.match(route, /case 'approve'/);
  assert.match(route, /executeApprovedPayout\(\{\s*\n?\s*referrerUserId,\s*\n?\s*approvedByEmail: user\.email!/,
    'manual approval must not pass an automatic amount cap');
  assert.doesNotMatch(readCode(ADMIN_PAYOUT), /REFERRAL_AUTO_PAYOUTS_ENABLED/,
    'the manual path must never depend on the automatic switch');
  assert.match(route, /Type \$\{expectedConfirmation/,
    'manual approval keeps its typed confirmation');
});

test('owner early release reuses the same atomic payout reservation and preserves the 30-day fallback', () => {
  const route = read(ADMIN_PAYOUT);
  const sql = read(EARLY_PAYOUT_SQL);

  assert.match(route, /case 'approve-early'/);
  assert.match(route, /approve_referral_reward_early/);
  assert.match(route, /executeApprovedPayout/);
  assert.match(sql, /original_eligible_at/,
    'the original 30-day maturity date remains recorded');
  assert.match(sql, /eligible_at <= now\(\) or exists/,
    'unapproved rewards still become eligible naturally');
  assert.match(sql, /pg_advisory_xact_lock[\s\S]*referral-payout:/,
    'release and reservation share the per-referrer money lock');
});

// ── The reward schedule is untouched ─────────────────────────────────────────

test('automation does not change the tiers: the maximum reward is still $25', async () => {
  const mod = await import(new URL('../monetization/web/lib/referralStatus.ts', `file://${__filename}`).href);
  assert.ok(mod, 'referralStatus stays loadable');

  const src = read(REFERRALS);
  assert.match(src, /min: 1,  max: 3,        cents: 1000/);
  assert.match(src, /min: 6,  max: Infinity, cents: 2000/);
  assert.match(src, /min: 6, max: Infinity, cents: 2500/);

  // No tier anywhere may exceed $25.00, with or without automation.
  const tierBlock = src.slice(src.indexOf('EARLY_REFERRAL_REWARD_TIERS'),
                              src.indexOf('REFERRAL_REWARD_CAP_PERCENT'));
  for (const match of tierBlock.matchAll(/cents:\s*(\d+)/g)) {
    assert.ok(Number(match[1]) <= 2500, `a reward tier of ${match[1]} exceeds the $25.00 maximum`);
  }
  assert.match(src, /REFERRAL_HOLD_DAYS = 30/, 'the 30-day hold is unchanged');
  assert.doesNotMatch(read(AUTO), /REFERRAL_HOLD_DAYS\s*=/,
    'automation must not redefine the hold');
});
