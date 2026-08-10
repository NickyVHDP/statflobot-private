'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), 'utf8');

const accountRoute = read('monetization', 'web', 'app', 'api', 'account', 'route.ts');
const licenseLib = read('monetization', 'web', 'lib', 'license.ts');
const signIn = read('monetization', 'web', 'app', 'auth', 'sign-in', 'page.tsx');
const signUp = read('monetization', 'web', 'app', 'auth', 'sign-up', 'page.tsx');
const resetWeb = read('monetization', 'web', 'app', 'auth', 'reset', 'page.tsx');
const resetDesktop = read('ui', 'client', 'src', 'screens', 'AuthScreen.jsx');
const cloudApi = read('ui', 'client', 'src', 'lib', 'cloudApi.js');
const subscriptionHook = read('ui', 'client', 'src', 'hooks', 'useSubscription.js');
const identityRoute = read('monetization', 'web', 'app', 'api', 'identity', 'lock', 'route.ts');
const monthlyCheckout = read('monetization', 'web', 'app', 'api', 'checkout', 'monthly', 'route.ts');
const lifetimeCheckout = read('monetization', 'web', 'app', 'api', 'checkout', 'lifetime', 'route.ts');
const webhook = read('monetization', 'web', 'app', 'api', 'webhooks', 'stripe', 'route.ts');
const successPage = read('monetization', 'web', 'app', 'checkout', 'success', 'page.tsx');
const subscriptionGate = read('ui', 'client', 'src', 'screens', 'SubscriptionGate.jsx');
const accountScreen = read('ui', 'client', 'src', 'screens', 'AccountScreen.jsx');

test('app account refresh reconciles site purchases before evaluating access', () => {
  assert.match(accountRoute, /reconcilePendingPurchase\(user\.id, user\.email/);
  assert.ok(accountRoute.indexOf('reconcilePendingPurchase') < accountRoute.indexOf("from('licenses')"));
});

test('guest monthly reconciliation persists Stripe paid-through truth before finalizing', () => {
  assert.match(licenseLib, /stripe\.subscriptions\.retrieve\(row\.stripe_subscription_id\)/);
  assert.match(licenseLib, /current_period_end:/);
  assert.match(licenseLib, /if \(writeResult\.error\) throw/);
  assert.ok(licenseLib.indexOf('if (writeResult.error)') < licenseLib.indexOf("status: 'reconciled'"));
});

test('desktop checkout has a public return page and identifies its source', () => {
  assert.match(cloudApi, /source: 'desktop'/);
  assert.match(monthlyCheckout, /checkout\/success\?source=desktop&plan=monthly/);
  assert.match(lifetimeCheckout, /checkout\/success\?source=desktop&plan=lifetime/);
  assert.match(successPage, /Return to the StatfloBot app/);
});

test('ordinary sign-in does not claim a payment succeeded', () => {
  assert.match(signIn, /checkoutStatus === 'pending'/);
  assert.doesNotMatch(signIn, /router\.push\('\/dashboard\?checkout=pending'\)/);
});

test('auth redirects are constrained and signup preserves the intended destination', () => {
  assert.match(signIn, /safeNextPath/);
  assert.match(signUp, /safeNextPath/);
  assert.match(signUp, /emailRedirectTo: callback\.toString\(\)/);
});

test('password reset remains on one web origin and offers link or code recovery', () => {
  assert.match(resetDesktop, /PUBLIC_SITE_URL\}\/auth\/reset/);
  assert.doesNotMatch(resetDesktop, /resetPasswordForEmail/);
  assert.match(resetWeb, /type: 'recovery'/);
  assert.match(resetWeb, /auth\/update-password/);
});

test('desktop prices come from the server instead of hardcoded checkout amounts', () => {
  assert.match(cloudApi, /fetchPricing/);
  assert.doesNotMatch(subscriptionGate, /\$50|\$10\/mo/);
  assert.doesNotMatch(accountScreen, /\$50|\$10\/mo/);
});

test('lifetime purchase cancels an existing monthly Stripe subscription', () => {
  assert.match(webhook, /stripe\.subscriptions\.cancel/);
  assert.match(webhook, /stripe_subscription_id:\s*null/);
  assert.match(licenseLib, /RECONCILE_LIFETIME_MONTHLY_CANCELED/);
  assert.match(monthlyCheckout, /lifetimeLicense/);
});

test('expired app sessions sign out instead of masquerading as an outage or paywall', () => {
  assert.match(cloudApi, /err\.status === 401/);
  assert.match(subscriptionHook, /_authExpired/);
  assert.match(subscriptionHook, /signOut\(\{ scope: 'local' \}\)/);
});

test('identity and license lookups tolerate historical multiple license rows', () => {
  assert.doesNotMatch(identityRoute, /\.eq\('user_id', user\.id\)[\s\S]{0,80}\.maybeSingle\(\)/);
  assert.match(identityRoute, /licenses\.find/);
  assert.match(licenseLib, /\.limit\(1\)\s*\.maybeSingle\(\)/);
});
