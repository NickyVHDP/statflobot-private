/**
 * Behavioural account-scoping tests for the support resolution notice.
 *
 * The rest of the support suite asserts on source text, which proves the scope
 * filters are *written*. These tests execute the real route handlers against an
 * in-memory stand-in for PostgREST, so they prove the filters actually *hold* —
 * including the case that prompted this work: an admin resolving someone else's
 * report must not inherit that customer's notice or email.
 *
 * Node strips the TypeScript types natively; a loader hook resolves the `@/`
 * alias and swaps `next/server` plus the Supabase/email/admin modules for stubs.
 * Everything under test — the filters, the projection, the ordering, the
 * idempotency conditions — is the shipped code.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { register } = require('node:module');

const WEB = path.join(__dirname, '..', 'monetization', 'web') + path.sep;

register(
  'data:text/javascript,' +
    encodeURIComponent(`
      const WEB = ${JSON.stringify(pathToFileURL(WEB).href)};
      const STUBS = {
        'next/server': \`
          // The routes import NextRequest as a value even though it is only used
          // as a type; type stripping cannot tell, so the stub must export it.
          export class NextRequest {}
          export class NextResponse {
            static json(body, init) {
              return { status: init?.status ?? 200, async json() { return body; } };
            }
          }\`,
        '@/lib/supabase/server': \`
          export const getAuthUser = (req) => globalThis.__support.getAuthUser(req);
          export const createServiceClient = () => globalThis.__support.createServiceClient();\`,
        '@/lib/admin': \`
          export const isAdminEmail = (email) => globalThis.__support.isAdminEmail(email);\`,
        '@/lib/supportEmail': \`
          export const customerEmailMode = () => globalThis.__support.customerEmailMode();
          export const sendResendEmail = (args) => globalThis.__support.sendResendEmail(args);
          export const buildResolutionEmail = (args) => globalThis.__support.buildResolutionEmail(args);\`,
      };
      export async function resolve(spec, ctx, next) {
        if (STUBS[spec]) return { url: 'stub:' + spec, shortCircuit: true };
        if (spec.startsWith('@/')) return next(WEB + spec.slice(2) + '.ts', ctx);
        return next(spec, ctx);
      }
      export async function load(url, ctx, next) {
        if (url.startsWith('stub:')) {
          return { format: 'module', shortCircuit: true, source: STUBS[url.slice(5)] };
        }
        return next(url, ctx);
      }
    `),
  pathToFileURL(__filename).href,
);

// ── Fake PostgREST ───────────────────────────────────────────────────────────
// Only the operators the support routes actually chain. Anything else throws
// rather than silently matching everything, so a future filter added to a route
// cannot pass these tests by being ignored.

class Query {
  constructor(store, table) {
    this.store = store;
    this.table = table;
    this.filters = [];
    this.mode = 'select';
    this.columns = null;
    this.patch = null;
    this.returning = null;
    this.single = false;
  }

  select(columns) {
    if (this.mode === 'update') this.returning = columns;
    else this.columns = columns;
    return this;
  }

  update(patch) {
    this.mode = 'update';
    this.patch = patch;
    return this;
  }

  eq(column, value) {
    this.filters.push((row) => row[column] === value);
    return this;
  }

  is(column, value) {
    assert.equal(value, null, 'fake .is() only models IS NULL');
    this.filters.push((row) => (row[column] ?? null) === null);
    return this;
  }

  order(column, opts) {
    this.sort = { column, ascending: opts?.ascending !== false };
    return this;
  }

  limit(n) {
    this.max = n;
    return this;
  }

  maybeSingle() {
    this.single = true;
    return this;
  }

  #project(row) {
    if (!this.columns) return { ...row };
    const out = {};
    for (const key of this.columns.split(',').map((c) => c.trim()).filter(Boolean)) {
      assert.ok(key in row, `projection asked for unknown column "${key}"`);
      out[key] = row[key];
    }
    return out;
  }

  #run() {
    const matched = this.store.rows.filter((row) => this.filters.every((f) => f(row)));

    if (this.mode === 'update') {
      for (const row of matched) Object.assign(row, this.patch);
      this.store.updates.push({ table: this.table, matched: matched.length, patch: this.patch });
      if (!this.returning) return { data: null, error: null };
      const rows = matched.map((row) => this.#project(row));
      return { data: this.single ? rows[0] ?? null : rows, error: null };
    }

    let rows = matched.map((row) => this.#project(row));
    if (this.sort) {
      const { column, ascending } = this.sort;
      rows.sort((a, b) => String(a[column] ?? '').localeCompare(String(b[column] ?? '')) * (ascending ? 1 : -1));
    }
    if (this.max != null) rows = rows.slice(0, this.max);
    return { data: this.single ? rows[0] ?? null : rows, error: null };
  }

  then(onFulfilled, onRejected) {
    return Promise.resolve(this.#run()).then(onFulfilled, onRejected);
  }
}

const ALICE = '11111111-1111-4111-8111-111111111111';
const BOB = '22222222-2222-4222-8222-222222222222';
const OWNER = '33333333-3333-4333-8333-333333333333';

const EMAILS = {
  [ALICE]: 'alice@example.com',
  [BOB]: 'bob@example.com',
  [OWNER]: 'owner@statflobot.app',
};

/** A stored report with every column the admin projection reads. */
function reportRow(overrides) {
  return {
    id: `id-${overrides.reference}`,
    reference: overrides.reference,
    user_id: overrides.user_id,
    bot_run_id: null,
    submission_id: null,
    status: 'received',
    subject: 'Run stopped early',
    description: 'Private customer description that must never reach another account.',
    contact_email: EMAILS[overrides.user_id],
    app_version: '1.5.59',
    platform: 'darwin',
    run_status: 'failed',
    log_attached: true,
    log_reference: 'run-2026-08-10.log',
    log_unavailable_reason: null,
    support_email_status: 'sent',
    support_email_sent_at: '2026-08-10T10:00:00.000Z',
    support_email_provider_id: 'prov-inbox',
    support_email_error: null,
    resolution_message: null,
    fixed_in_version: null,
    resolved_at: null,
    resolved_by_user_id: null,
    resolved_by_email: null,
    resolution_email_status: 'none',
    resolution_email_attempted_at: null,
    resolution_email_attempts: 0,
    resolution_email_sent_at: null,
    resolution_email_provider_id: null,
    resolution_email_error: null,
    acknowledged_at: null,
    created_at: '2026-08-10T10:00:00.000Z',
    updated_at: '2026-08-10T10:00:00.000Z',
  };
}

/** A report already resolved and awaiting its owner's acknowledgement. */
function resolvedRow(overrides) {
  return {
    ...reportRow(overrides),
    status: 'resolved',
    resolution_message: 'Fixed the early stop on paginated smart lists.',
    fixed_in_version: '1.5.60',
    resolved_at: '2026-08-11T09:00:00.000Z',
    resolved_by_user_id: OWNER,
    resolved_by_email: EMAILS[OWNER],
    resolution_email_status: 'sent',
    resolution_email_sent_at: '2026-08-11T09:00:01.000Z',
    resolution_email_provider_id: 'prov-resolution',
    ...overrides.extra,
  };
}

let store;
let sent;

function install(rows, { currentUser = null } = {}) {
  store = { rows, updates: [] };
  sent = [];
  globalThis.__support = {
    current: currentUser,
    getAuthUser: () => globalThis.__support.current,
    isAdminEmail: (email) => email === EMAILS[OWNER],
    customerEmailMode: () => 'live',
    buildResolutionEmail: () => ({ subject: 'stub', html: 'stub' }),
    sendResendEmail: async (args) => {
      sent.push(args);
      return { ok: true, providerId: 'prov-new' };
    },
    createServiceClient: () => ({
      from: (table) => new Query(store, table),
      auth: {
        admin: {
          getUserById: async (id) => ({
            data: { user: { id, email: EMAILS[id], email_confirmed_at: '2026-01-01T00:00:00.000Z' } },
            error: null,
          }),
        },
      },
    }),
  };
}

function signIn(userId) {
  globalThis.__support.current = userId ? { id: userId, email: EMAILS[userId] } : null;
}

const req = (url = 'https://app.example/api/support/notices', body) => ({
  nextUrl: new URL(url),
  json: async () => {
    if (body === undefined) throw new Error('no body');
    return body;
  },
});

const load = (rel) => import(pathToFileURL(path.join(WEB, rel)).href);

async function getNotices(query = '') {
  const { GET } = await load('app/api/support/notices/route.ts');
  const res = await GET(req(`https://app.example/api/support/notices${query}`));
  return { status: res.status, body: await res.json() };
}

async function ack(reference) {
  const { POST } = await load('app/api/support/notices/ack/route.ts');
  const res = await POST(req('https://app.example/api/support/notices/ack', { reference }));
  return { status: res.status, body: await res.json() };
}

// The reported reference read as SR-9RO4XAMDH9A4EGET, but Crockford Base32 has
// no O — that character is a transcribed zero, so the stored reference is this.
const ALICE_REF = 'SR-9R04XAMDH9A4EGET';
const BOB_REF = 'SR-0123456789ABCDEF';

// ── Tests ────────────────────────────────────────────────────────────────────

test('the reporting account sees its own resolved notice', async () => {
  install([resolvedRow({ reference: ALICE_REF, user_id: ALICE })], { currentUser: { id: ALICE, email: EMAILS[ALICE] } });
  const { status, body } = await getNotices('?installedVersion=1.5.59');

  assert.equal(status, 200);
  assert.equal(body.pendingNotice?.reference, ALICE_REF);
  assert.equal(body.pendingCount, 1);
  assert.equal(body.pendingNotice.resolutionMessage, 'Fixed the early stop on paginated smart lists.');
});

test('another signed-in customer cannot retrieve that notice', async () => {
  install(
    [resolvedRow({ reference: ALICE_REF, user_id: ALICE }), reportRow({ reference: BOB_REF, user_id: BOB })],
    { currentUser: { id: BOB, email: EMAILS[BOB] } },
  );
  const { status, body } = await getNotices();

  assert.equal(status, 200);
  assert.equal(body.pendingNotice, null);
  assert.equal(body.pendingCount, 0);
  assert.deepEqual(body.reports.map((r) => r.reference), [BOB_REF]);
});

test('another customer cannot acknowledge a notice they do not own', async () => {
  install([resolvedRow({ reference: ALICE_REF, user_id: ALICE })], { currentUser: { id: BOB, email: EMAILS[BOB] } });
  const { status, body } = await ack(ALICE_REF);

  // Opaque by design: a 404 here would confirm the reference exists.
  assert.equal(status, 200);
  assert.equal(body.ok, true);
  assert.equal(store.rows[0].acknowledged_at, null, "another account's ack must not mark the row seen");

  signIn(ALICE);
  assert.equal((await getNotices()).body.pendingNotice?.reference, ALICE_REF);
});

test('acknowledgement is idempotent and scoped to the owner', async () => {
  install([resolvedRow({ reference: ALICE_REF, user_id: ALICE })], { currentUser: { id: ALICE, email: EMAILS[ALICE] } });

  assert.equal((await ack(ALICE_REF)).body.ok, true);
  const first = store.rows[0].acknowledged_at;
  assert.ok(first, 'the owner ack must stamp acknowledged_at');

  assert.equal((await ack(ALICE_REF)).body.ok, true);
  assert.equal(store.rows[0].acknowledged_at, first, 'a repeat ack must not re-stamp the row');
  assert.equal(store.updates.at(-1).matched, 0, 'the second ack must match no rows');

  assert.equal((await getNotices()).body.pendingNotice, null);
});

test('both customer endpoints reject an unauthenticated caller', async () => {
  install([resolvedRow({ reference: ALICE_REF, user_id: ALICE })], { currentUser: null });

  assert.equal((await getNotices()).status, 401);
  assert.equal((await ack(ALICE_REF)).status, 401);
  assert.equal(store.rows[0].acknowledged_at, null);
});

test('the resolving admin does not inherit the customer notice', async () => {
  process.env.PUBLIC_APP_VERSION = '1.5.60';
  install([reportRow({ reference: ALICE_REF, user_id: ALICE })], { currentUser: { id: OWNER, email: EMAILS[OWNER] } });

  const { POST } = await load('app/api/admin/support/resolve/route.ts');
  const res = await POST(
    req('https://app.example/api/admin/support/resolve', {
      reference: ALICE_REF,
      resolutionMessage: 'Fixed the early stop on paginated smart lists.',
      fixedInVersion: '1.5.60',
    }),
  );
  const body = await res.json();
  assert.equal(res.status, 200, JSON.stringify(body));
  assert.equal(body.emailSent, true);

  // The one email goes to the reporting account, never to the resolver.
  assert.deepEqual(sent.map((e) => e.to), [EMAILS[ALICE]]);

  // The admin resolved it, so the admin is signed in — and still sees nothing.
  assert.equal((await getNotices()).body.pendingNotice, null);
  assert.equal((await getNotices()).body.pendingCount, 0);

  signIn(ALICE);
  assert.equal((await getNotices()).body.pendingNotice?.reference, ALICE_REF);
});

test('an admin who filed the report does see their own notice', async () => {
  // The reported behaviour was correct in this case only: the popup followed
  // support_reports.user_id, which happened to be the signed-in owner.
  install([resolvedRow({ reference: ALICE_REF, user_id: OWNER })], { currentUser: { id: OWNER, email: EMAILS[OWNER] } });
  assert.equal((await getNotices()).body.pendingNotice?.reference, ALICE_REF);
});

test('the customer payload carries no private logs, internals, or admin identity', async () => {
  install([resolvedRow({ reference: ALICE_REF, user_id: ALICE })], { currentUser: { id: ALICE, email: EMAILS[ALICE] } });
  const { body } = await getNotices();
  const serialized = JSON.stringify(body);

  for (const leak of [
    'Private customer description',
    'run-2026-08-10.log',
    EMAILS[OWNER],
    OWNER,
    ALICE,
    'prov-resolution',
    'prov-inbox',
  ]) {
    assert.ok(!serialized.includes(leak), `customer payload must not expose ${leak}`);
  }
  assert.deepEqual(
    Object.keys(body.pendingNotice).sort(),
    ['acknowledgedAt', 'createdAt', 'fixDelivery', 'fixedInVersion', 'reference', 'resolutionMessage', 'resolvedAt', 'status', 'subject'],
  );
});

test('the oldest unacknowledged notice is shown first', async () => {
  install(
    [
      resolvedRow({ reference: ALICE_REF, user_id: ALICE, extra: { resolved_at: '2026-08-11T09:00:00.000Z' } }),
      resolvedRow({
        reference: 'SR-AAAAAAAAAAAAAAAA',
        user_id: ALICE,
        extra: { resolved_at: '2026-08-09T09:00:00.000Z', created_at: '2026-08-08T10:00:00.000Z' },
      }),
    ],
    { currentUser: { id: ALICE, email: EMAILS[ALICE] } },
  );

  const { body } = await getNotices();
  assert.equal(body.pendingCount, 2);
  assert.equal(body.pendingNotice.reference, 'SR-AAAAAAAAAAAAAAAA');
});

test('a fix that is not public yet is never announced as downloadable', async () => {
  process.env.PUBLIC_APP_VERSION = '1.5.59';
  install(
    [resolvedRow({ reference: ALICE_REF, user_id: ALICE, extra: { fixed_in_version: '1.6.0' } })],
    { currentUser: { id: ALICE, email: EMAILS[ALICE] } },
  );

  const { body } = await getNotices('?installedVersion=1.5.59');
  assert.equal(body.pendingNotice.fixedInVersion, null);
  assert.equal(body.pendingNotice.fixDelivery, 'pending-release');
  process.env.PUBLIC_APP_VERSION = '1.5.60';
});
