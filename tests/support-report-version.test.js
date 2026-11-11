'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { pathToFileURL } = require('node:url');
const { register } = require('node:module');
const { normalizeAppVersion, readRunVersion } = require('../src/run-version');

const root = path.join(__dirname, '..');
const web = pathToFileURL(path.join(root, 'monetization/web') + path.sep).href;
register('data:text/javascript,' + encodeURIComponent(`
  const WEB = ${JSON.stringify(web)};
  const stubs = {
    'next/server': 'export class NextRequest {} export class NextResponse { static json(body, init) { return { status: init?.status ?? 200, json: async () => body }; } }',
    '@/lib/supabase/server': 'export const getAuthUser = () => globalThis.__reportTest.user; export const createServiceClient = () => globalThis.__reportTest.client;',
  };
  export async function resolve(spec, ctx, next) {
    if (stubs[spec]) return { url: 'report-stub:' + spec, shortCircuit: true };
    if (spec.startsWith('@/')) return next(WEB + spec.slice(2) + '.ts', ctx);
    return next(spec, ctx);
  }
  export async function load(url, ctx, next) {
    if (url.startsWith('report-stub:')) return { format: 'module', shortCircuit: true, source: stubs[url.slice(12)] };
    return next(url, ctx);
  }
`), pathToFileURL(__filename).href);

test('only explicit run metadata identifies a version, not a version mentioned in a note', async () => {
  const helpers = await import(web + 'lib/supportReports.ts');
  for (const [content, expected] of [
    ['{"appVersion":"1.5.85","level":"warn","msg":"page missing"}', '1.5.85'],
    ['[INFO] [RUN_VERSION] appVersion=v1.5.82\n[WARN] page missing', '1.5.82'],
    ['[INFO] [RUN_VERSION] appVersion=unknown', null],
    ['Customer-friendly explanation of what was fixed\n1.5.84', null],
    ['{"level":"info","msg":"fixed in 1.5.85"}', null],
  ]) {
    assert.equal(readRunVersion(content), expected);
    assert.equal(helpers.diagnosticRunVersion(content), expected);
  }
  assert.equal(normalizeAppVersion('unknown'), null);
  const decorated = helpers.versionedSupportDiagnostics('[WARN] missing page', '1.5.82');
  assert.match(decorated, /^\[INFO\] \[RUN_VERSION\] appVersion=1\.5\.82\n/);
  const sanitized = helpers.versionedSupportDiagnostics('client="Test Customer" test@example.com\npassword=private-value', '1.5.85');
  assert.doesNotMatch(sanitized, /Test Customer|test@example.com|private-value/);
  assert.match(sanitized, /\[REDACTED\]/);
});

test('raw log entries and serialization fallbacks record the injected runtime version', () => {
  const writes = [];
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(root, 'src/logger.js'), 'utf8'), {
    module,
    require(name) {
      if (name === 'fs') return { mkdirSync() {}, appendFileSync(_file, text) { writes.push(JSON.parse(text)); } };
      if (name === './config') return { logsDir: '/tmp/unit-test-only' };
      if (name === './run-version') return { normalizeAppVersion };
      return require(name);
    },
    process: { env: { STATFLOBOT_APP_VERSION: '1.5.85' } },
    console: { log() {}, warn() {}, error() {} },
  });
  const circular = {}; circular.self = circular;
  module.exports.info('normal entry');
  module.exports.info('serialization fallback', circular);
  assert.equal(writes.length, 2);
  assert.ok(writes.every(line => line.appVersion === '1.5.85'));
});

test('long sanitized log tails retain their version without leaking customer content', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'statflobot-report-version-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'run.log');
  const entries = Array.from({ length: 250 }, (_, i) => ({
    appVersion: '1.5.82', level: 'info', msg: `event=${i} ${'x'.repeat(150)}`,
  }));
  entries.push({ appVersion: '1.5.82', level: 'warn', msg: 'client="Test Customer" email test@example.com' });
  fs.writeFileSync(file, entries.map(line => JSON.stringify(line)).join('\n'));
  const text = require('../src/run-reporter').sanitizeLog(file);
  assert.match(text, /^\[INFO\] \[RUN_VERSION\] appVersion=1\.5\.82\n/);
  assert.ok(text.length <= 8000);
  assert.doesNotMatch(text, /Test Customer|test@example.com/);
  assert.match(text, /event=249/);
});

test('the local report endpoint prefers the server runtime and never relabels an older run', async () => {
  const source = fs.readFileSync(path.join(root, 'ui/server/index.js'), 'utf8');
  const start = source.indexOf("app.post('/api/support/report'");
  const route = source.slice(start, source.indexOf('\n});', start) + 4);
  for (const [serverVersion, logContent, expectedRunVersion] of [
    ['1.5.85', '{"appVersion":"1.5.84","level":"warn","msg":"old run"}', '1.5.84'],
    ['1.5.85', '[WARN] legacy run', null],
  ]) {
    let handler;
    let forwarded;
    vm.runInNewContext(route, {
      app: { post(_path, fn) { handler = fn; } },
      normalizeAppVersion, readRunVersion,
      state: { lastRunStatus: 'failed' },
      resolveLatestFailedLog: () => ({ content: logContent, file: 'run-test.log', available: true, reason: null }),
      tailLog: text => ({ text, truncated: false }),
      SERVER_VERSION: serverVersion,
      CLOUD_API_URL: 'https://example.invalid',
      fs: { mkdirSync() {}, writeFileSync() {} }, path, os,
      process: { env: {}, platform: 'darwin' }, AbortSignal,
      console: { log() {}, warn() {} },
      fetch: async (_url, options) => {
        forwarded = JSON.parse(options.body);
        return { ok: true, headers: { get: () => 'application/json' }, json: async () => ({ emailSent: true, logIncluded: true }) };
      },
    });
    await handler({ body: {
      email: 'reporter@example.invalid', subject: 'Run issue', description: 'Send never lit up.', version: 'v1.2.5',
    }, headers: {} }, { json() {} });
    assert.equal(forwarded.version, '1.5.85');
    assert.equal(forwarded.runVersion, expectedRunVersion);
    assert.equal(forwarded.description, 'Send never lit up.');
  }
});

class Query {
  constructor(store, table) { this.store = store; this.table = table; this.filters = []; this.action = 'select'; }
  select() { return this; }
  eq(key, value) { this.filters.push(row => row[key] === value); return this; }
  gte(key, value) { this.filters.push(row => row[key] >= value); return this; }
  lte(key, value) { this.filters.push(row => row[key] <= value); return this; }
  not(key, _operator, value) { this.filters.push(row => row[key] != value); return this; }
  order() { return this; }
  limit() { return this; }
  insert(value) { this.action = 'insert'; this.value = value; return this; }
  update(value) { this.action = 'update'; this.value = value; return this; }
  single() { this.one = true; return this; }
  maybeSingle() { this.one = true; return this; }
  then(resolve, reject) {
    try {
      if (!['bot_runs', 'support_reports'].includes(this.table)) throw new Error('Unexpected table');
      const table = this.store[this.table];
      if (this.action === 'insert') table.push({ id: 'new-report-id', ...this.value });
      const rows = table.filter(row => this.filters.every(filter => filter(row)));
      if (this.action === 'update') rows.forEach(row => Object.assign(row, this.value));
      return Promise.resolve({ data: this.one ? rows[0] ?? null : rows, error: null }).then(resolve, reject);
    } catch (error) { return Promise.reject(error).then(resolve, reject); }
  }
}

async function submit(t, body = {}, runs = []) {
  const state = { bot_runs: runs, support_reports: [], emails: [], user: { id: 'reporter', email: 'reporter@example.invalid' } };
  state.client = { from: table => new Query(state, table) };
  globalThis.__reportTest = state;
  const priorFetch = global.fetch;
  const priorKey = process.env.RESEND_API_KEY;
  process.env.RESEND_API_KEY = 'unit-test-placeholder';
  global.fetch = async (url, options) => {
    assert.equal(url, 'https://api.resend.com/emails');
    state.emails.push(JSON.parse(options.body));
    return { ok: true, json: async () => ({ id: 'test-email' }) };
  };
  t.after(() => {
    global.fetch = priorFetch;
    if (priorKey === undefined) delete process.env.RESEND_API_KEY; else process.env.RESEND_API_KEY = priorKey;
    delete globalThis.__reportTest;
  });
  const { POST } = await import(web + 'app/api/support/report/route.ts');
  const result = await POST({ json: async () => ({
    contactEmail: 'reporter@example.invalid', subject: 'Run issue', description: 'Send never lit up.',
    version: 'v1.5.85', platform: 'darwin', timestamp: '2026-11-11T12:00:00.000Z', ...body,
  }) });
  assert.equal(result.status, 200);
  return state;
}

const runId = '11111111-2222-4333-8444-555555555555';

test('an older history run retains its version after the app has updated', async t => {
  const state = await submit(t, { historyRunId: runId }, [{
    id: runId, user_id: 'reporter', app_version: '1.5.82', raw_log_sanitized: '[WARN] older run page failed',
  }]);
  assert.equal(state.support_reports[0].app_version, '1.5.82');
  assert.equal(state.support_reports[0].bot_run_id, runId);
  assert.match(state.emails[0].html, /Run app version[\s\S]*1\.5\.82/);
  assert.match(state.emails[0].html, /App version when report sent[\s\S]*1\.5\.85/);
  assert.match(state.emails[0].html, /\[RUN_VERSION\] appVersion=1\.5\.82/);
  assert.match(state.emails[0].html, /Send never lit up\./);
});

test('an owned history run keeps its recorded version even when its log is unavailable', async t => {
  const state = await submit(t, { historyRunId: runId }, [{
    id: runId, user_id: 'reporter', app_version: '1.5.82', raw_log_sanitized: null,
  }]);
  assert.equal(state.support_reports[0].app_version, '1.5.82');
  assert.equal(state.support_reports[0].log_attached, false);
  assert.match(state.emails[0].html, /Run app version[\s\S]*1\.5\.82/);
});

test('linked recent diagnostics use the matched run version, not the current version', async t => {
  const state = await submit(t, { runStatus: 'failed' }, [{
    id: runId, user_id: 'reporter', app_version: '1.5.84', platform: 'darwin', status: 'failed',
    created_at: '2026-11-11T11:59:00.000Z', raw_log_sanitized: '[WARN] previous run failed',
  }]);
  assert.equal(state.support_reports[0].app_version, '1.5.84');
  assert.match(state.emails[0].html, /\[RUN_VERSION\] appVersion=1\.5\.84/);
});

test('local raw diagnostics carry their own runtime version without a cloud history row', async t => {
  const state = await submit(t, {
    logContent: '{"appVersion":"1.5.84","level":"warn","msg":"page failed"}',
    runVersion: '1.5.84', runStatus: 'failed',
  });
  assert.equal(state.support_reports[0].app_version, '1.5.84');
  assert.match(state.emails[0].html, /\[RUN_VERSION\] appVersion=1\.5\.84/);
});

test('a nearby run from a different build cannot replace local diagnostic metadata', async t => {
  const state = await submit(t, {
    logContent: '{"appVersion":"1.5.84","level":"warn","msg":"actual local failure"}',
    runVersion: '1.5.84', runStatus: 'failed',
  }, [{ id: runId, user_id: 'reporter', app_version: '1.5.82', platform: 'darwin', status: 'failed',
    created_at: '2026-11-11T11:59:00.000Z', raw_log_sanitized: 'DIFFERENT BUILD DIAGNOSTIC' }]);
  assert.equal(state.support_reports[0].app_version, '1.5.84');
  assert.equal(state.support_reports[0].bot_run_id, null);
  assert.match(state.emails[0].html, /actual local failure/);
  assert.doesNotMatch(state.emails[0].html, /DIFFERENT BUILD DIAGNOSTIC/);
});

test('legacy logs with no version remain unknown instead of blaming the installed release', async t => {
  const state = await submit(t, { logContent: '[WARN] older run failed', runStatus: 'failed' });
  assert.equal(state.support_reports[0].app_version, null);
  assert.match(state.emails[0].html, /Unknown \(not recorded in this run\)/);
  assert.match(state.emails[0].html, /\[RUN_VERSION\] appVersion=unknown/);
  assert.doesNotMatch(state.emails[0].html, /\[RUN_VERSION\] appVersion=1\.5\.85/);
});

test('a selected run cannot borrow another account’s version or a different nearby run', async t => {
  const state = await submit(t, { historyRunId: runId }, [
    { id: runId, user_id: 'someone-else', app_version: '1.5.81', raw_log_sanitized: 'PRIVATE FOREIGN DIAGNOSTIC' },
    { id: 'own-nearby-run', user_id: 'reporter', app_version: '1.5.82', platform: 'darwin',
      created_at: '2026-11-11T11:59:00.000Z', raw_log_sanitized: 'DIFFERENT RUN DIAGNOSTIC' },
  ]);
  assert.equal(state.support_reports[0].app_version, null);
  assert.equal(state.support_reports[0].bot_run_id, null);
  assert.doesNotMatch(state.emails[0].html, /PRIVATE FOREIGN DIAGNOSTIC|DIFFERENT RUN DIAGNOSTIC/);
});

test('owner UI labels the reported version separately from the release that fixes it', () => {
  const source = fs.readFileSync(path.join(root, 'ui/client/src/components/AdminSupportReports.jsx'), 'utf8');
  assert.match(source, /Reported app \/ run version:/);
  assert.match(source, /selected\.app_version/);
  assert.match(source, /Fixed in released version \(not the customer’s run version\)/);
  assert.match(source, /diagnostics\.appVersion/);
});
