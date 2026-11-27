const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const loadApproval = () => import('../ui/client/src/lib/payoutApproval.js');
const member = { referrerUserId: 'member-test', code: 'TESTCODE', referrerEmail: 'member@example.invalid', eligibleCents: 1000, payoutsEnabled: true };

test('opening a normal payout snapshots its recipient, amount, and required confirmation', async () => {
  const { buildPayoutApproval } = await loadApproval();
  const approval = buildPayoutApproval(member);
  assert.equal(approval.action, 'approve');
  assert.equal(approval.recipient, 'member@example.invalid');
  assert.equal(approval.amount, '$10.00');
  assert.equal(approval.expected, 'PAY TESTCODE');
  assert.equal(approval.attributionId, undefined);
});

test('early release retains the separate confirmation with the full available amount', async () => {
  const { buildPayoutApproval } = await loadApproval();
  const approval = buildPayoutApproval(member, { attributionId: 'reward-test', amountCents: 1500 });
  assert.equal(approval.action, 'approve-early');
  assert.equal(approval.expected, 'PAY NOW TESTCODE $25.00');
  assert.equal(approval.attributionId, 'reward-test');
});

test('empty, cancelled, partial, wrong-person, and wrong-action input cannot authorize a payout', async () => {
  const { buildPayoutApproval, matchesPayoutApproval } = await loadApproval();
  const approval = buildPayoutApproval(member);
  for (const text of [null, undefined, '', 'PAY', 'PAY OTHER', 'PAY NOW TESTCODE $10.00', 'PAY TESTCODE EXTRA']) {
    assert.equal(matchesPayoutApproval(approval, text), false);
  }
  assert.equal(matchesPayoutApproval(null, 'PAY TESTCODE'), false);
  assert.equal(matchesPayoutApproval(approval, ' pay testcode '), true);
});

test('an early payout cannot be confirmed with a missing or incorrect amount', async () => {
  const { buildPayoutApproval, matchesPayoutApproval } = await loadApproval();
  const approval = buildPayoutApproval(member, { attributionId: 'reward-test', amountCents: 1000 });
  assert.equal(matchesPayoutApproval(approval, 'PAY TESTCODE'), false);
  assert.equal(matchesPayoutApproval(approval, 'PAY NOW TESTCODE $10.00'), false);
  assert.equal(matchesPayoutApproval(approval, 'PAY NOW TESTCODE $20.00'), true);
});

test('missing identity or an invalid balance never opens an approval', async () => {
  const { buildPayoutApproval } = await loadApproval();
  for (const patch of [{ code: '' }, { referrerUserId: null }, { eligibleCents: 0 }, { eligibleCents: -1000 }, { eligibleCents: NaN }, { eligibleCents: 1.5 }]) {
    assert.throws(() => buildPayoutApproval({ ...member, ...patch }), /Refresh referrals/);
  }
  assert.throws(() => buildPayoutApproval(member, { amountCents: 1000 }), /Refresh referrals/);
});

test('desktop approval uses an in-app dialog instead of Electron-unsupported prompt()', () => {
  const source = fs.readFileSync(path.join(__dirname, '../ui/client/src/components/AdminReferralsOverview.jsx'), 'utf8');
  const modal = fs.readFileSync(path.join(__dirname, '../ui/client/src/components/PayoutApprovalModal.jsx'), 'utf8');
  assert.doesNotMatch(source, /window\.prompt\(/);
  assert.match(source, /<PayoutApprovalModal/);
  assert.match(source, /onCancel=\{\(\) => setApproval\(null\)\}/);
  assert.match(source, /matchesPayoutApproval\(approval, typed\) \|\| actionLock\.current/);
  assert.match(source, /act\(selected\.action, selected\.row, selected\.attributionId, typed\)/);
  assert.match(source, /if \(actionLock\.current\) return;\s*actionLock\.current = true/);
  assert.match(modal, /role="dialog" aria-modal="true"/);
  assert.match(modal, /disabled=\{!valid\}/);
  assert.match(modal, /if \(valid\) onConfirm\(typed\)/);
  assert.match(modal, /not guaranteed to arrive instantly/);
});
