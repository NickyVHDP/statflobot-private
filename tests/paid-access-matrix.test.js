/**
 * The paid-access decision, enumerated.
 *
 * `hasAccess` in monetization/web/app/api/account/route.ts is the single gate
 * the desktop app trusts (ui/server verifyAccess forwards it verbatim). Two
 * defects lived in it: an *inactive* lifetime license granted access, and an
 * active monthly license outlived its expired subscription for one request.
 *
 * The formula is mirrored here so every combination is stated explicitly, plus
 * source guards so the real route cannot drift away from this mirror.
 */

'use strict';

const test   = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('node:fs');
const path   = require('node:path');

const ROUTE = fs.readFileSync(
  path.join(__dirname, '..', 'monetization', 'web', 'app', 'api', 'account', 'route.ts'),
  'utf8',
);
const STRIPE_LIB = fs.readFileSync(
  path.join(__dirname, '..', 'monetization', 'web', 'lib', 'stripe.ts'),
  'utf8',
);

const FUTURE = new Date(Date.now() + 30 * 864e5).toISOString();
const PAST   = new Date(Date.now() - 30 * 864e5).toISOString();

/** Mirror of evaluateMonthlyAccess() in monetization/web/lib/stripe.ts. */
function evaluateMonthlyAccess(sub) {
  if (!sub) return false;
  const endsInFuture = sub.current_period_end ? new Date(sub.current_period_end) > new Date() : false;
  if (sub.status === 'active')   return endsInFuture;
  if (sub.status === 'canceled') return endsInFuture;   // already paid for this period
  return false;                                          // trialing / past_due / unpaid
}

/**
 * Mirror of the hasAccess computation in app/api/account/route.ts.
 *
 * Fails closed: a monthly license grants access only while an active
 * subscription backs it. A MISSING subscription row is unbacked just like an
 * expired one — the two are distinguished only to decide whether the denial is
 * repairable, never whether access is granted.
 */
function computeAccess({ license, sub }) {
  const hasLicense = !!(license && license.status === 'active');
  const isLifetime = sub?.status === 'lifetime' || (hasLicense && license?.plan === 'lifetime');
  const monthlyAllowed = !isLifetime && evaluateMonthlyAccess(sub);
  const hasSub = isLifetime || monthlyAllowed;
  const isMonthlyLicense = hasLicense && license?.plan === 'monthly' && !isLifetime;
  const monthlyLicenseUnbacked = isMonthlyLicense && !monthlyAllowed;
  return (hasLicense && !monthlyLicenseUnbacked) || hasSub;
}

/** Mirror of the accessIssue classification. */
function computeAccessIssue({ license, sub }) {
  if (computeAccess({ license, sub })) return null;
  const hasLicense = !!(license && license.status === 'active');
  const isLifetime = sub?.status === 'lifetime' || (hasLicense && license?.plan === 'lifetime');
  const monthlyAllowed = !isLifetime && evaluateMonthlyAccess(sub);
  const isMonthlyLicense = hasLicense && license?.plan === 'monthly' && !isLifetime;
  if (isMonthlyLicense && !sub)  return { code: 'subscription-record-missing', repairable: true };
  if (isMonthlyLicense && !monthlyAllowed) return { code: 'subscription-expired', repairable: false };
  return null;
}

const cases = [
  // ── Lifetime ────────────────────────────────────────────────────────────
  ['active lifetime license, no subscription',
    { license: { status: 'active', plan: 'lifetime' }, sub: null }, true],
  ['INACTIVE lifetime license, no subscription',
    { license: { status: 'inactive', plan: 'lifetime' }, sub: null }, false],
  ['lifetime subscription, no license row',
    { license: null, sub: { status: 'lifetime' } }, true],
  ['active lifetime license alongside a long-expired monthly subscription',
    { license: { status: 'active', plan: 'lifetime' }, sub: { status: 'canceled', current_period_end: PAST } }, true],

  // ── Monthly, paid ───────────────────────────────────────────────────────
  ['active monthly license with a live subscription',
    { license: { status: 'active', plan: 'monthly' }, sub: { status: 'active', current_period_end: FUTURE } }, true],
  ['cancelled subscription still inside the paid period',
    { license: { status: 'active', plan: 'monthly' }, sub: { status: 'canceled', current_period_end: FUTURE } }, true],
  ['live subscription with no license row yet',
    { license: null, sub: { status: 'active', current_period_end: FUTURE } }, true],

  // ── Monthly, unpaid ─────────────────────────────────────────────────────
  ['active monthly license whose subscription expired',
    { license: { status: 'active', plan: 'monthly' }, sub: { status: 'active', current_period_end: PAST } }, false],
  ['active monthly license with a cancelled, elapsed subscription',
    { license: { status: 'active', plan: 'monthly' }, sub: { status: 'canceled', current_period_end: PAST } }, false],
  ['past_due subscription',
    { license: { status: 'active', plan: 'monthly' }, sub: { status: 'past_due', current_period_end: FUTURE } }, false],
  ['inactive monthly license',
    { license: { status: 'inactive', plan: 'monthly' }, sub: null }, false],
  ['no license and no subscription',
    { license: null, sub: null }, false],

  // ── Paid-only: trials never unlock the bot ──────────────────────────────
  ['trialing subscription, no license',
    { license: null, sub: { status: 'trialing', current_period_end: FUTURE } }, false],
  ['trialing subscription alongside an active monthly license',
    { license: { status: 'active', plan: 'monthly' }, sub: { status: 'trialing', current_period_end: FUTURE } }, false],

  // ── Partial data: the webhook can provision a license without persisting the
  //    subscription row (it logs MONTHLY_SUB_UPSERT_FAILED and continues).
  //    Paid-only means this FAILS CLOSED — an unbacked monthly license must not
  //    grant indefinite access. The denial is flagged repairable so a genuine
  //    payer gets a support path rather than a paywall.
  ['active monthly license with NO subscription row',
    { license: { status: 'active', plan: 'monthly' }, sub: null }, false],
];

for (const [name, input, expected] of cases) {
  test(`access — ${name} → ${expected ? 'granted' : 'denied'}`, () => {
    assert.equal(computeAccess(input), expected);
  });
}

// ── Source guards: the real route must still implement this formula ─────────

test('the route ties the lifetime test to an active license', () => {
  assert.match(
    ROUTE,
    /isLifetime\s*=\s*activeSub\?\.status === 'lifetime' \|\| \(hasLicense && licenseRes\.data\?\.plan === 'lifetime'\)/,
    'an inactive lifetime license must not grant access',
  );
});

test('an unbacked monthly license is denied whether the record is expired or absent', () => {
  const match = ROUTE.match(/const monthlyLicenseUnbacked\s*=([\s\S]*?);/);
  assert.ok(match, 'monthlyLicenseUnbacked not found');
  assert.match(match[1], /monthlySubMissing/, 'a missing subscription row must deny access');
  assert.match(match[1], /monthlySubExpired/, 'an expired subscription must deny access');
});

test('the license is deactivated only on positive evidence of expiry', () => {
  // Deactivating on a missing row destroys the record support needs to repair a
  // genuine payer, and the customer cannot undo it.
  const guard = ROUTE.match(/if \(monthlySubExpired &&[\s\S]{0,120}\) \{\s*\n\s*deactivateLicense/);
  assert.ok(guard, 'deactivation must require positive expiry and may additionally require authoritative Stripe sync');
});

// ── Repairable-denial classification ────────────────────────────────────────

test('a missing subscription record is reported as repairable', () => {
  const issue = computeAccessIssue({ license: { status: 'active', plan: 'monthly' }, sub: null });
  assert.equal(issue?.code, 'subscription-record-missing');
  assert.equal(issue?.repairable, true, 'a payer whose record did not save must get a support path');
});

test('an expired subscription is reported as not repairable', () => {
  const issue = computeAccessIssue({
    license: { status: 'active', plan: 'monthly' },
    sub: { status: 'active', current_period_end: PAST },
  });
  assert.equal(issue?.code, 'subscription-expired');
  assert.equal(issue?.repairable, false);
});

test('a customer with access has no access issue', () => {
  assert.equal(computeAccessIssue({ license: { status: 'active', plan: 'lifetime' }, sub: null }), null);
});

test('the route returns accessIssue and logs the missing-record case loudly', () => {
  assert.match(ROUTE, /accessIssue,/, 'accessIssue must be returned in the account payload');
  assert.match(ROUTE, /subscription-record-missing/);
  assert.match(ROUTE, /repairable: true/);
  assert.match(ROUTE, /MONTHLY_ACCESS_DENIED_NO_SUBSCRIPTION_RECORD/,
    'the missing-record denial needs a structured log line support can search');
  assert.match(ROUTE, /console\.error\(\s*\n?\s*`\[MONTHLY_ACCESS_DENIED_NO_SUBSCRIPTION_RECORD\]/,
    'it should be an error-level log, not buried at info level');
});

test('the desktop run gate surfaces a repairable denial instead of the paywall', () => {
  const APP = fs.readFileSync(path.join(__dirname, '..', 'ui', 'client', 'src', 'App.jsx'), 'utf8');
  assert.match(APP, /accessIssue\?\.repairable/,
    'App.jsx must branch on repairable so a paid customer is not told to buy again');
  const SERVER = fs.readFileSync(path.join(__dirname, '..', 'ui', 'server', 'index.js'), 'utf8');
  assert.match(SERVER, /accessIssue/, 'ui/server must forward accessIssue from the cloud');
});

test('the route no longer grants access from a bare active license', () => {
  assert.doesNotMatch(
    ROUTE,
    /const hasAccess\s*=\s*hasLicense \|\| hasSub/,
    'hasLicense alone contradicted the stale-license deactivation below it',
  );
});

test('evaluateMonthlyAccess denies trialing', () => {
  // The signature spans several lines, so start from the end of the parameter
  // list rather than the declaration when isolating the body.
  const fn = STRIPE_LIB.slice(STRIPE_LIB.indexOf('export function evaluateMonthlyAccess'));
  const bodyStart = fn.indexOf('): boolean {');
  assert.ok(bodyStart !== -1, 'could not locate the function body');
  const body = fn.slice(bodyStart, fn.indexOf('\n}', bodyStart));

  assert.doesNotMatch(body, /'trialing'/, 'paid-only: a trial period must not unlock the bot');
  assert.match(body, /status === 'active'/);
});
