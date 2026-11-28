const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { register } = require('node:module');
const web = pathToFileURL(path.join(__dirname, '../monetization/web') + path.sep).href;
const NOW = Date.parse('2026-11-27T20:00:00Z');
const cutoff = new Date(NOW - 30 * 86400000).toISOString();
register('data:text/javascript,' + encodeURIComponent(`
  const WEB = ${JSON.stringify(web)};
  const stubs = {
    'next/server': 'export class NextRequest {} export class NextResponse { static json(body, init) { return { status: init?.status ?? 200, body }; } }',
    '@/lib/admin': 'export const isAdminEmail = email => email === "owner@example.invalid";',
    '@/lib/supabase/server': 'export const getAuthUser = () => globalThis.__supportWindow.user; export const createServiceClient = () => globalThis.__supportWindow.client;',
    '@/lib/supportReports': 'export const ADMIN_REPORT_COLUMNS = "id,email"; export const DESKTOP_REPORT_COLUMNS = "id,status,created_at"; export const getPublicAppVersion = async () => "1.5.87";',
  };
  export async function resolve(spec, ctx, next) {
    if (stubs[spec]) return { url: 'support-window:' + spec, shortCircuit: true };
    if (spec.startsWith('@/')) return next(WEB + spec.slice(2) + '.ts', ctx);
    return next(spec, ctx);
  }
  export async function load(url, ctx, next) {
    if (url.startsWith('support-window:')) return { format: 'module', shortCircuit: true, source: stubs[url.slice(15)] };
    return next(url, ctx);
  }
`), pathToFileURL(__filename).href);

function setup(t) {
  const state = globalThis.__supportWindow = { user: { email: 'owner@example.invalid' }, queries: 0, rows: [
    { id: 'old-open', status: 'received', created_at: new Date(Date.parse(cutoff) - 1).toISOString() },
    { id: 'boundary', status: 'resolved', created_at: cutoff },
    { id: 'new', status: 'received', created_at: new Date(NOW).toISOString() },
  ] };
  state.client = { from(table) {
    assert.equal(table, 'support_reports');
    state.queries++;
    let filter = () => true;
    return {
      select(columns) { state.columns = columns; return this; },
      gte(key, value) { filter = row => row[key] >= value; return this; },
      lt(key, value) { filter = row => row[key] < value; return this; },
      order() { return this; }, limit() { return this; },
      then(resolve, reject) { return Promise.resolve({ data: state.rows.filter(filter), error: state.error }).then(resolve, reject); },
    };
  } };
  t.mock.method(Date, 'now', () => NOW);
  t.mock.method(globalThis, 'fetch', () => { throw new Error('Network forbidden'); });
  return state;
}
const request = range => ({ nextUrl: new URL('https://example.invalid/api/admin/support/reports?view=desktop' + (range == null ? '' : '&range=' + encodeURIComponent(range))) });

test('support opens to the last 30 days, including the exact boundary', async t => {
  const state = setup(t);
  const { GET } = await import(web + 'app/api/admin/support/reports/route.ts');
  const response = await GET(request());
  assert.equal(response.status, 200);
  assert.deepEqual(response.body.reports.map(r => r.id), ['boundary', 'new']);
  assert.equal(response.body.cutoff, cutoff);
  assert.equal(state.columns, 'id,status,created_at', 'desktop projection must stay narrow');
  assert.equal(state.rows.length, 3, 'no report is deleted or changed');
});
test('older view includes unanswered old reports without marking them resolved or notifying anyone', async t => {
  const state = setup(t);
  const { GET } = await import(web + 'app/api/admin/support/reports/route.ts');
  const response = await GET(request('older'));
  assert.deepEqual(response.body.reports.map(r => r.id), ['old-open']);
  assert.equal(state.rows[0].status, 'received');
});
test('invalid archive selections fall back to recent instead of widening access', async t => {
  setup(t);
  const { GET } = await import(web + 'app/api/admin/support/reports/route.ts');
  assert.equal((await GET(request('all&view=web'))).body.range, 'recent');
});
test('unauthenticated and non-admin archive requests never read reports', async t => {
  const state = setup(t);
  const { GET } = await import(web + 'app/api/admin/support/reports/route.ts');
  state.user = null;
  assert.equal((await GET(request('older'))).status, 401);
  state.user = { email: 'member@example.invalid' };
  assert.equal((await GET(request('older'))).status, 403);
  assert.equal(state.queries, 0);
});
test('desktop archive selector is allowlisted end-to-end and keeps attention on recent reports', () => {
  const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
  assert.match(read('ui/server/index.js'), /req\.query\.range === 'older' \? 'older' : 'recent'/);
  assert.match(read('ui/client/src/lib/cloudApi.js'), /range === 'older' \? 'older' : 'recent'/);
  const ui = read('ui/client/src/components/AdminSupportReports.jsx');
  assert.match(ui, /Last 30 days/);
  assert.match(ui, /Older reports/);
  assert.match(ui, /summarizeSupportReports\(recent\?\.reports \?\? next\)/);
});
