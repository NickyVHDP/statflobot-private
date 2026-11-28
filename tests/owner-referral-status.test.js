const test = require('node:test');
const assert = require('node:assert/strict');
const load = () => import('../monetization/web/lib/referralStatus.ts');
const NOW = Date.parse('2026-11-27T20:00:00Z');
const accrual = (id, user = 'a', created = '2026-09-01T00:00:00Z') => ({ entry_type: 'accrual', attribution_id: id, referrer_user_id: user, amount_cents: 1000, created_at: created, eligible_at: '2026-10-01T00:00:00Z' });
const debit = (id, user = 'a', created = '2026-11-01T00:00:00Z', amount = -1000) => ({ entry_type: 'payout', payout_id: id, referrer_user_id: user, amount_cents: amount, created_at: created });
const payout = (id, status = 'paid', amount = 1000) => ({ id, status, amount_cents: amount });

test('a settled payout completes only the oldest reward covered by its ledger debit', async () => {
  const { deriveOwnerReferralStatuses } = await load();
  const statuses = deriveOwnerReferralStatuses({ ledger: [accrual('old'), accrual('new', 'a', '2026-09-02T00:00:00Z'), debit('p')], payouts: [payout('p')], now: NOW });
  assert.equal(statuses.get('old'), 'completed');
  assert.equal(statuses.get('new'), 'eligible');
});
test('processing is not completed and another member never inherits a payout', async () => {
  const { deriveOwnerReferralStatuses } = await load();
  const statuses = deriveOwnerReferralStatuses({ ledger: [accrual('one'), accrual('other', 'b'), debit('p')], payouts: [payout('p', 'processing')], now: NOW });
  assert.equal(statuses.get('one'), 'processing');
  assert.equal(statuses.get('other'), 'eligible');
});
test('failed, returned, unknown, and partially covered payouts never mark a reward completed', async () => {
  const { deriveOwnerReferralStatuses } = await load();
  for (const status of ['failed', 'returned', 'canceled', 'unknown']) {
    assert.equal(deriveOwnerReferralStatuses({ ledger: [accrual('one'), debit('p')], payouts: [payout('p', status)], now: NOW }).get('one'), 'eligible');
  }
  assert.equal(deriveOwnerReferralStatuses({ ledger: [accrual('one'), debit('p', 'a', undefined, -500)], payouts: [payout('p', 'paid', 500)], now: NOW }).get('one'), 'eligible');
});
test('an older payment cannot complete a new referral that did not exist when it was sent', async () => {
  const { deriveOwnerReferralStatuses } = await load();
  const statuses = deriveOwnerReferralStatuses({ ledger: [accrual('new', 'a', '2026-11-02T00:00:00Z'), debit('p')], payouts: [payout('p')], now: NOW });
  assert.equal(statuses.get('new'), 'eligible');
});
test('post-payout reversal stays reversed and does not transfer the paid label to a later reward', async () => {
  const { deriveOwnerReferralStatuses } = await load();
  const statuses = deriveOwnerReferralStatuses({ ledger: [accrual('old'), debit('p'), { entry_type: 'reversal', attribution_id: 'old', referrer_user_id: 'a', amount_cents: -1000, created_at: '2026-11-02T00:00:00Z' }, accrual('new', 'a', '2026-11-03T00:00:00Z')], payouts: [payout('p')], now: NOW });
  assert.equal(statuses.get('old'), 'reversed');
  assert.equal(statuses.get('new'), 'eligible');
});
test('early release must exist at payment time; unreleased rewards remain clearing', async () => {
  const { deriveOwnerReferralStatuses } = await load();
  const entry = { ...accrual('one'), eligible_at: '2026-12-01T00:00:00Z' };
  const args = { ledger: [entry, debit('p')], payouts: [payout('p')], now: NOW };
  assert.equal(deriveOwnerReferralStatuses(args).get('one'), 'clearing');
  assert.equal(deriveOwnerReferralStatuses({ ...args, earlyApprovals: [{ attribution_id: 'one', approved_at: '2026-10-31T00:00:00Z' }] }).get('one'), 'completed');
  assert.equal(deriveOwnerReferralStatuses({ ...args, earlyApprovals: [{ attribution_id: 'one', approved_at: '2026-11-02T00:00:00Z' }] }).get('one'), 'eligible');
});
test('active payout controls exclude settled and unused codes, but retain clearing, payable, and in-flight rewards', async () => {
  const { activePayoutQueue } = await import('../ui/client/src/lib/ownerAttention.js');
  const rows = [{ id: 'settled', paidCents: 1000 }, { id: 'unused', awaitingPayment: 2 }, { id: 'held', pendingCents: 1000 }, { id: 'ready', eligibleCents: 1000 }, { id: 'transit', processingCents: 1000 }];
  assert.deepEqual(activePayoutQueue(rows).map(row => row.id), ['held', 'ready', 'transit']);
  assert.equal(rows.length, 5, 'audit records are not mutated or removed');
});
