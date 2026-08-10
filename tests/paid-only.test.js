/**
 * StatfloBot is paid-only. These are source-level guards, not behaviour tests:
 * they exist so the free-trial gate cannot be reintroduced by a merge, and so
 * no unpaid subscription status quietly regains access.
 */

'use strict';

const test   = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('node:fs');
const path   = require('node:path');
const { execFileSync } = require('node:child_process');

const REPO = path.join(__dirname, '..');

function read(rel) {
  return fs.readFileSync(path.join(REPO, rel), 'utf8');
}

/** Tracked files only — build output and dependencies are not our source. */
function trackedFiles() {
  return execFileSync('git', ['ls-files'], { cwd: REPO, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
    .split('\n')
    .filter(Boolean);
}

test('no free-trial gate identifiers exist anywhere in tracked source', () => {
  // The removed gate: one free run per Statflo username, enforced through a
  // statflo_identities table and an authorize-run endpoint.
  const banned = [
    /free[_-]?trial/i,
    /trialStatus/,
    /trialConsumed/,
    /statflo_identities/,
    /authorize-run/,
  ];

  const offenders = [];
  for (const file of trackedFiles()) {
    // This test file names the identifiers on purpose.
    if (file === 'tests/paid-only.test.js') continue;
    // Editor/tool config is not product source.
    if (file.startsWith('.claude/')) continue;

    const abs = path.join(REPO, file);
    let content;
    try {
      content = fs.readFileSync(abs, 'utf8');
    } catch {
      continue; // binary or unreadable
    }
    if (content.includes('\u0000')) continue; // binary file

    for (const pattern of banned) {
      if (pattern.test(content)) offenders.push(`${file} matches ${pattern}`);
    }
  }

  assert.deepEqual(offenders, [], `free-trial residue found:\n${offenders.join('\n')}`);
});

test("'trialing' does not grant bot access on the desktop server", () => {
  const src = read('ui/server/index.js');
  const set = src.match(/const ACTIVE_STATUSES = new Set\(\[([^\]]*)\]\)/);
  assert.ok(set, 'ACTIVE_STATUSES not found in ui/server/index.js');
  assert.doesNotMatch(set[1], /trialing/, 'a trialing subscription must not unlock the bot');
  assert.match(set[1], /'active'/);
  assert.match(set[1], /'lifetime'/);
});

test("'trialing' does not grant access in the desktop client fallback", () => {
  const src = read('ui/client/src/hooks/useSubscription.js');
  const set = src.match(/const ACTIVE_STATUSES = new Set\(\[([^\]]*)\]\)/);
  assert.ok(set, 'ACTIVE_STATUSES not found in useSubscription.js');
  assert.doesNotMatch(set[1], /trialing/);
});

test("'trialing' does not grant access in the cloud access evaluator", () => {
  const src = read('monetization/web/lib/stripe.ts');
  const fn = src.slice(src.indexOf('export function evaluateMonthlyAccess'));
  assert.ok(fn.length > 0, 'evaluateMonthlyAccess not found');
  const body = fn.slice(0, fn.indexOf('\n}'));
  assert.doesNotMatch(body, /status === 'trialing'/, 'evaluateMonthlyAccess must deny trialing');
});

test("'trialing' does not pass the cloud license gate", () => {
  const src = read('monetization/web/app/api/licenses/verify/route.ts');
  const list = src.match(/const validSubStatus\s*=\s*\[([^\]]*)\]/);
  assert.ok(list, 'validSubStatus not found');
  assert.doesNotMatch(list[1], /trialing/);
});

test('no Trial badge is rendered in the desktop or web UI', () => {
  for (const file of [
    'ui/client/src/screens/AccountScreen.jsx',
    'monetization/web/app/dashboard/DashboardClient.tsx',
  ]) {
    const src = read(file);
    assert.doesNotMatch(src, /label:\s*'Trial'/, `${file} still renders a Trial badge`);
  }
});

test('the desktop run gate refuses to decide access from an unverified JWT', () => {
  const src = read('ui/server/index.js');
  const start = src.indexOf("app.post('/api/start'");
  assert.ok(start !== -1, '/api/start handler not found');
  const handler = src.slice(start, start + 4000);

  const effective = handler.match(/const effectiveEmail\s*=\s*([^;]+);/);
  assert.ok(effective, 'effectiveEmail assignment not found in /api/start');
  assert.doesNotMatch(
    effective[1],
    /jwtEmail/,
    'the admin bypass must use the cloud-verified email only — decodeJwtEmail does not verify the signature, ' +
    'so a hand-written token carrying the owner address would authorise a run',
  );
});

test('the account proxy does not synthesise an admin account from an unverified JWT', () => {
  const src = read('ui/server/index.js');
  const start = src.indexOf("app.get('/api/proxy/account'");
  assert.ok(start !== -1, '/api/proxy/account handler not found');
  const handler = src.slice(start, start + 2500);
  assert.doesNotMatch(
    handler,
    /isLocalAdminEmail\(\s*jwtEmail\s*\)/,
    'the proxy must not grant admin access from an unverified JWT email',
  );
});
