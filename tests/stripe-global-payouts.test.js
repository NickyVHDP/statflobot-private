const { test } = require('node:test');
const assert = require('node:assert/strict');

const loadPayouts = () => import('../monetization/web/lib/stripeGlobalPayouts.ts');

// Exercise the shipped adapter with fake responses only: no .env files,
// customer data, network calls, database writes, or money movement.
function mockStripe(t, handler) {
  const originalKey = process.env.STRIPE_SECRET_KEY;
  const originalVersion = process.env.STRIPE_GLOBAL_PAYOUTS_API_VERSION;
  process.env.STRIPE_SECRET_KEY = 'unit-test-only-not-a-credential';
  delete process.env.STRIPE_GLOBAL_PAYOUTS_API_VERSION;
  t.after(() => {
    if (originalKey === undefined) delete process.env.STRIPE_SECRET_KEY;
    else process.env.STRIPE_SECRET_KEY = originalKey;
    if (originalVersion === undefined) delete process.env.STRIPE_GLOBAL_PAYOUTS_API_VERSION;
    else process.env.STRIPE_GLOBAL_PAYOUTS_API_VERSION = originalVersion;
  });
  return t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(options.method, 'GET', 'readiness checks must never send money');
    assert.equal(options.body, undefined);
    assert.equal(options.headers['Stripe-Version'], '2026-07-29.preview');
    return handler(new URL(url), options);
  });
}

test('recipient readiness uses indexed include fields accepted by Stripe API v2', async (t) => {
  const recipient = {
    id: 'acct_test_recipient',
    configuration: { recipient: { capabilities: { bank_accounts: { local: { status: 'active' } } } } },
    requirements: { entries: [] },
  };
  const fetchMock = mockStripe(t, (url, options) => {
    assert.equal(url.origin, 'https://api.stripe.com');
    assert.equal(url.pathname, '/v2/core/accounts/acct_test_recipient');
    assert.equal(options.headers['Stripe-Context'], undefined);
    // Reproduce Stripe's rejection of unindexed arrays. This fails against
    // the old adapter instead of silently accepting the same invalid request.
    if (url.searchParams.has('include[]')) {
      return Response.json({ error: { code: 'invalid_fields', message: 'Use exact array indexes' } }, { status: 400 });
    }
    assert.deepEqual([...url.searchParams.entries()], [
      ['include[0]', 'configuration.recipient'],
      ['include[1]', 'requirements'],
    ]);
    return Response.json(recipient);
  });
  const { retrieveGlobalRecipient } = await loadPayouts();
  assert.deepEqual(await retrieveGlobalRecipient(recipient.id), recipient);
  assert.equal(fetchMock.mock.callCount(), 1);
});

test('recipient IDs are encoded as a path component, not extra query fields', async (t) => {
  mockStripe(t, (url) => {
    assert.equal(url.pathname, '/v2/core/accounts/acct_test%2F%3Finclude%5B2%5D%3Didentity');
    assert.equal(url.searchParams.has('include[2]'), false);
    return Response.json({ id: 'acct_test' });
  });
  const { retrieveGlobalRecipient } = await loadPayouts();
  await retrieveGlobalRecipient('acct_test/?include[2]=identity');
});

test('Stripe readiness errors remain errors rather than a false ready response', async (t) => {
  mockStripe(t, () => Response.json({
    error: { code: 'invalid_fields', message: 'Invalid recipient request' },
  }, { status: 400 }));
  const { retrieveGlobalRecipient, StripeGlobalPayoutsError } = await loadPayouts();
  await assert.rejects(retrieveGlobalRecipient('acct_test'), (error) => {
    assert.ok(error instanceof StripeGlobalPayoutsError);
    assert.equal(error.status, 400);
    assert.equal(error.code, 'invalid_fields');
    return true;
  });
});

test('bank-method readiness stays recipient-scoped and excludes ineligible or archived methods', async (t) => {
  const ready = { id: 'usba_ready', type: 'bank_account', usage_status: { payments: 'eligible' }, bank_account: { archived: false } };
  mockStripe(t, (url, options) => {
    assert.equal(url.pathname, '/v2/money_management/payout_methods');
    assert.equal(options.headers['Stripe-Context'], 'acct_test_recipient');
    return Response.json({ data: [
      ready,
      { id: 'usba_disabled', type: 'bank_account', usage_status: { payments: 'disabled' } },
      { id: 'usba_archived', type: 'bank_account', usage_status: { payments: 'eligible' }, bank_account: { archived: true } },
      { id: 'card_archived', type: 'card', usage_status: { payments: 'eligible' }, card: { archived: true } },
      { id: 'usba_unknown', type: 'bank_account' },
    ] });
  });
  const { listEligibleGlobalPayoutMethods } = await loadPayouts();
  assert.deepEqual(await listEligibleGlobalPayoutMethods('acct_test_recipient'), [ready]);
});

test('financial-account reads do not inherit recipient-only include parameters', async (t) => {
  mockStripe(t, (url) => {
    assert.equal(url.pathname, '/v2/money_management/financial_accounts/fa_test');
    assert.equal(url.search, '');
    return Response.json({ id: 'fa_test', balance: { available: { usd: { value: 2500 } } } });
  });
  const { retrieveGlobalFinancialAccount, availableUsdCents } = await loadPayouts();
  assert.equal(availableUsdCents(await retrieveGlobalFinancialAccount('fa_test')), 2500);
});
