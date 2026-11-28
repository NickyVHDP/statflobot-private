const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { register } = require('node:module');

// Run the real sync, preflight, and owner route against in-memory dependencies.
// No credentials, customer accounts, network requests, or money movement.
const web = pathToFileURL(path.join(__dirname, '../monetization/web') + path.sep).href;
register('data:text/javascript,' + encodeURIComponent(`
  const WEB = ${JSON.stringify(web)};
  const stubs = {
    'next/server': 'export class NextRequest {} export class NextResponse { static json(body, init) { return { status: init?.status ?? 200, json: async () => body }; } }',
    '@/lib/supabase/server': 'export const getAuthUser = () => globalThis.__bankTest.user; export const createServiceClient = () => globalThis.__bankTest.client;',
    '@/lib/admin': 'export const isAdminEmail = email => email === "owner@example.invalid"; export const isOwnerEmail = isAdminEmail;',
    '@/lib/license': 'export const auditLog = () => { throw new Error("No payout audit writes expected"); };',
    '@/lib/referrals': 'export const arePayoutsEnabled = () => globalThis.__bankTest.enabled; export const getPayoutThresholdCents = () => 1000; export const getReferralBalance = async () => ({ eligibleCents: 1000 }); export const getReferralRewardTiers = () => [{ min: 1, max: Infinity, cents: 1000 }]; export const REFERRAL_ACCRUAL_CENTS = 1000; export const REFERRAL_HOLD_DAYS = 30;',
    '@/lib/stripeGlobalPayouts': 'export class StripeGlobalPayoutsError extends Error {} export const retrieveGlobalRecipient = id => globalThis.__bankTest.recipient(id); export const listEligibleGlobalPayoutMethods = id => globalThis.__bankTest.methods(id); export const createGlobalOutboundPayment = () => { throw new Error("Must not issue payouts"); }; export const createGlobalRecipient = () => { throw new Error("Must not create recipients"); }; export const createGlobalRecipientLink = () => { throw new Error("Must not create enrollment links"); }; export const retrieveGlobalOutboundPayment = () => { throw new Error("No existing payouts expected"); }; export const retrieveGlobalFinancialAccount = () => { throw new Error("No funding calls expected"); }; export const availableUsdCents = () => 0;',
    '@/lib/pricing': 'export const getPricingWindow = async () => ({ earlyBird: {}, lifetime_plan_code: "lifetime_standard" });',
    '@/lib/referralAutoPayouts': 'export const AUTOMATIC_PAYOUT_APPROVER = "automatic"; export const AUTO_PAYOUT_RUN_UTC_HOUR = 15; export const AUTO_PAYOUT_RUN_UTC_MINUTE = 17; export const getAutoPayoutConfig = () => ({ enabled: true, invalidSettings: [], limits: { reserveCents: 2500 }, feeCents: 150, financialAccountConfigured: false });',
  };
  export async function resolve(spec, ctx, next) {
    if (ctx.parentURL === WEB + 'lib/referralPayouts.ts' && spec.startsWith('./')) spec = '@/lib/' + spec.slice(2);
    if (stubs[spec]) return { url: 'bank-test:' + spec, shortCircuit: true };
    if (spec.startsWith('@/')) return next(WEB + spec.slice(2) + '.ts', ctx);
    return next(spec, ctx);
  }
  export async function load(url, ctx, next) {
    if (url.startsWith('bank-test:')) return { format: 'module', shortCircuit: true, source: stubs[url.slice(10)] };
    return next(url, ctx);
  }
`), pathToFileURL(__filename).href);

class Query {
  constructor(table) { this.table = table; this.filters = []; }
  select(columns) { this.columns = columns; return this; }
  update(patch) { this.patch = patch; return this; }
  eq(key, value) { this.filters.push(row => row[key] === value); return this; }
  in(key, values) { this.filters.push(row => values.includes(row[key])); return this; }
  not(key, op, value) { assert.equal(op, 'is'); assert.equal(value, null); this.filters.push(row => row[key] != null); return this; }
  gte(key, value) { this.filters.push(row => row[key] >= value); return this; }
  order() { return this; }
  limit() { return this; }
  maybeSingle() { this.single = true; return this; }
  then(resolve, reject) {
    const state = globalThis.__bankTest;
    const error = this.table === 'referral_payout_accounts' && (this.patch ? state.writeError : state.readError);
    if (error) return Promise.resolve({ data: null, error: { message: 'Fixture database unavailable' } }).then(resolve, reject);
    const rows = (state.tables[this.table] || []).filter(row => this.filters.every(filter => filter(row)));
    if (this.patch) {
      assert.equal(this.table, 'referral_payout_accounts', 'only bank-readiness metadata may change');
      assert.ok(this.filters.length > 0, 'updates must be scoped to the referrer');
      rows.forEach(row => Object.assign(row, this.patch));
      state.writes.push({ table: this.table, count: rows.length, patch: this.patch });
      return Promise.resolve({ data: null, error: null }).then(resolve, reject);
    }
    const projected = rows.map(row => Object.fromEntries(this.columns.split(',').map(column => [column.trim(), row[column.trim()]])));
    return Promise.resolve({ data: this.single ? projected[0] ?? null : projected, error: null }).then(resolve, reject);
  }
}

function account(id, ready = false) {
  return { referrer_user_id: id, stripe_recipient_id: 'acct_' + id,
    stripe_payout_method_id: ready ? 'usba_' + id : null, payout_method_ready: ready,
    onboarding_status: ready ? 'complete' : 'created', provider: 'stripe_global_payouts' };
}
function setup(t, accounts = [account('member')]) {
  const originalFinancialAccount = process.env.STRIPE_GLOBAL_PAYOUTS_FINANCIAL_ACCOUNT_ID;
  process.env.STRIPE_GLOBAL_PAYOUTS_FINANCIAL_ACCOUNT_ID = 'fa_unit_test_only';
  t.after(() => {
    if (originalFinancialAccount === undefined) delete process.env.STRIPE_GLOBAL_PAYOUTS_FINANCIAL_ACCOUNT_ID;
    else process.env.STRIPE_GLOBAL_PAYOUTS_FINANCIAL_ACCOUNT_ID = originalFinancialAccount;
  });
  const state = globalThis.__bankTest = {
    enabled: true, user: { email: 'owner@example.invalid' }, writes: [], calls: [],
    tables: { referral_payout_accounts: accounts,
      referral_codes: accounts.map(row => ({ referrer_user_id: row.referrer_user_id, code: 'TEST_' + row.referrer_user_id })) },
    client: { from: table => new Query(table), rpc() { throw new Error('No payout RPCs allowed'); },
      auth: { admin: { getUserById: async id => ({ data: { user: { email: id + '@example.invalid' } } }) } } },
    async recipient(id) { state.calls.push(id); return { configuration: { recipient: { capabilities: { bank_accounts: { local: { status: 'active' } } } } } }; },
    async methods(id) { return [{ id: 'usba_' + id.slice(5), type: 'bank_account' }]; },
  };
  t.mock.method(globalThis, 'fetch', () => { throw new Error('Network requests forbidden in this suite'); });
  return state;
}
const loadPayouts = () => import(web + 'lib/referralPayouts.ts');
const loadOwner = () => import(web + 'app/api/admin/referrals/route.ts');
const ownerRequest = () => ({ nextUrl: new URL('https://example.invalid/api/admin/referrals?view=overview') });

test('owner ledger marks a posted reward completed and an in-flight reward processing', async t => {
  const state = setup(t);
  state.tables.referral_attributions = [{ id: 'reward', referrer_user_id: 'member', reward_cents: 1000, created_at: '2026-08-01T00:00:00Z' }];
  state.tables.referral_ledger = [
    { id: 'credit', entry_type: 'accrual', attribution_id: 'reward', referrer_user_id: 'member', amount_cents: 1000, created_at: '2026-08-01T00:00:00Z', eligible_at: '2026-09-01T00:00:00Z' },
    { id: 'debit', entry_type: 'payout', payout_id: 'payment', referrer_user_id: 'member', amount_cents: -1000, created_at: '2026-09-02T00:00:00Z' },
  ];
  const payment = { id: 'payment', referrer_user_id: 'member', amount_cents: 1000, status: 'paid', created_at: '2026-09-02T00:00:00Z' };
  state.tables.referral_payouts = [payment];
  const { GET } = await loadOwner();
  const request = { nextUrl: new URL('https://example.invalid/api/admin/referrals?view=owner-desktop') };
  let body = await (await GET(request)).json();
  assert.equal(body.referralActivity[0].status, 'completed');
  assert.equal(body.queue[0].paidCents, 1000);
  assert.equal(body.queue[0].eligibleCents, 0);
  assert.equal(body.queue[0].automaticNextStep, 'Completed — no payout pending');
  payment.status = 'processing';
  body = await (await GET(request)).json();
  assert.equal(body.referralActivity[0].status, 'processing');
  assert.match(body.queue[0].automaticNextStep, /Payout processing/);
});

test('status sync saves and returns verified readiness without touching another member', async t => {
  const state = setup(t, [account('member'), account('other')]);
  const { syncGlobalPayoutAccount } = await loadPayouts();
  const result = await syncGlobalPayoutAccount('member');
  assert.equal(result.payout_method_ready, true);
  assert.equal(result.onboarding_status, 'complete');
  assert.equal(state.tables.referral_payout_accounts[0].stripe_payout_method_id, 'usba_member');
  assert.equal(state.tables.referral_payout_accounts[1].payout_method_ready, false);
  assert.equal(state.writes.length, 1);
});

test('a bank method alone is insufficient until Stripe activates the capability', async t => {
  const state = setup(t);
  state.recipient = async () => ({ configuration: { recipient: { capabilities: { bank_accounts: { local: { status: 'pending' } } } } } });
  const { syncGlobalPayoutAccount } = await loadPayouts();
  assert.equal((await syncGlobalPayoutAccount('member')).payout_method_ready, false);
});

test('an active capability without an eligible method does not become ready', async t => {
  const state = setup(t);
  state.methods = async () => [];
  const { syncGlobalPayoutAccount } = await loadPayouts();
  assert.equal((await syncGlobalPayoutAccount('member')).payout_method_ready, false);
});

test('owner Check refreshes a formerly incomplete record without the member opening the app', async t => {
  const state = setup(t);
  const { preflightPayout } = await loadPayouts();
  const result = await preflightPayout('member');
  assert.equal(result.ok, true);
  assert.equal(result.stripePayoutMethodId, 'usba_member');
  assert.deepEqual(state.calls, ['acct_member']);
  assert.equal(state.writes.length, 1);
});

test('Check refuses a stale ready flag when Stripe cannot be verified', async t => {
  const state = setup(t, [account('member', true)]);
  state.recipient = async () => { throw new Error('Fixture Stripe unavailable'); };
  const { preflightPayout } = await loadPayouts();
  const result = await preflightPayout('member');
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'payout-status-unavailable');
  assert.equal(state.writes.length, 0);
});

test('failed lookup or persistence cannot be mistaken for a successful refresh', async t => {
  const state = setup(t);
  const { syncGlobalPayoutAccount } = await loadPayouts();
  state.readError = true;
  await assert.rejects(syncGlobalPayoutAccount('member'), /Could not read/);
  assert.deepEqual(state.calls, []);
  state.readError = false;
  state.writeError = true;
  await assert.rejects(syncGlobalPayoutAccount('member'), /Could not persist/);
  assert.equal(state.writes.length, 0);
});

test('owner refresh projects freshly verified readiness into the same response', async t => {
  const state = setup(t);
  const { GET } = await loadOwner();
  const response = await GET(ownerRequest());
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.queue[0].connectStatus, 'complete');
  assert.equal(result.queue[0].payoutsEnabled, true);
  assert.deepEqual(state.calls, ['acct_member']);
});

test('one unavailable recipient does not hide another ready recipient', async t => {
  const state = setup(t, [account('member', true), account('other')]);
  const retrieve = state.recipient;
  state.recipient = async id => { if (id === 'acct_member') throw new Error('Fixture failure'); return retrieve(id); };
  const { GET } = await loadOwner();
  const result = await (await GET(ownerRequest())).json();
  assert.equal(result.queue[0].connectStatus, 'unavailable');
  assert.equal(result.queue[0].payoutsEnabled, false);
  assert.equal(result.queue[0].automaticNextStep, 'Bank status unavailable — retry Check');
  assert.equal(result.queue[1].payoutsEnabled, true);
});

test('the desktop owner ledger also returns refreshed status with owner-only identities', async t => {
  setup(t);
  const { GET } = await loadOwner();
  const request = ownerRequest();
  request.nextUrl.searchParams.set('view', 'owner-desktop');
  const result = await (await GET(request)).json();
  assert.equal(result.queue[0].payoutsEnabled, true);
  assert.equal(result.queue[0].connectStatus, 'complete');
  assert.equal(result.queue[0].referrerEmail, 'member@example.invalid');
});

test('owner refresh bounds Stripe concurrency to four recipients', async t => {
  const state = setup(t, Array.from({ length: 9 }, (_, i) => account('member' + i)));
  const retrieve = state.recipient;
  let active = 0, maximum = 0;
  state.recipient = async id => {
    active++; maximum = Math.max(maximum, active);
    await new Promise(resolve => setImmediate(resolve));
    active--; return retrieve(id);
  };
  const { GET } = await loadOwner();
  const result = await (await GET(ownerRequest())).json();
  assert.equal(maximum, 4);
  assert.ok(result.queue.every(row => row.payoutsEnabled));
});

test('unauthenticated and non-admin requests do not trigger Stripe refreshes', async t => {
  const state = setup(t);
  const { GET } = await loadOwner();
  state.user = null;
  assert.equal((await GET(ownerRequest())).status, 401);
  state.user = { email: 'member@example.invalid' };
  assert.equal((await GET(ownerRequest())).status, 403);
  assert.deepEqual(state.calls, []);
  assert.equal(state.writes.length, 0);
});
