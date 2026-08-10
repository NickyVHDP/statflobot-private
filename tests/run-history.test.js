'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const apiSource = fs.readFileSync(path.join(root, 'monetization', 'web', 'app', 'api', 'runs', 'route.ts'), 'utf8');
const serverSource = fs.readFileSync(path.join(root, 'ui', 'server', 'index.js'), 'utf8');
const screenSource = fs.readFileSync(path.join(root, 'ui', 'client', 'src', 'screens', 'RunHistoryScreen.jsx'), 'utf8');
const reporterSource = fs.readFileSync(path.join(root, 'src', 'run-reporter.js'), 'utf8');
const mainSource = fs.readFileSync(path.join(root, 'src', 'main.js'), 'utf8');
const appSource = fs.readFileSync(path.join(root, 'ui', 'client', 'src', 'App.jsx'), 'utf8');
const supportSource = fs.readFileSync(path.join(root, 'ui', 'client', 'src', 'screens', 'SupportScreen.jsx'), 'utf8');
const statfloSource = fs.readFileSync(path.join(root, 'src', 'statflo.js'), 'utf8');

test('cloud history is authenticated and scoped to the signed-in account', () => {
  const getStart = apiSource.indexOf('export async function GET');
  const postStart = apiSource.indexOf('export async function POST');
  assert.ok(getStart > -1 && postStart > getStart, 'GET history route must exist before POST reporting');
  const getRoute = apiSource.slice(getStart, postStart);
  assert.match(getRoute, /getAuthUser\(req\)/);
  assert.match(getRoute, /if \(!user\)[\s\S]*status: 401/);
  assert.match(getRoute, /\.eq\('user_id', user\.id\)/);
});

test('cloud history is limited to 30 days and a bounded number of rows', () => {
  assert.match(apiSource, /const HISTORY_DAYS = 30/);
  assert.match(apiSource, /const HISTORY_LIMIT = 100/);
  assert.match(apiSource, /\.gte\('created_at', cutoff\)/);
  assert.match(apiSource, /\.order\('created_at', \{ ascending: false \}\)/);
  assert.match(apiSource, /\.limit\(HISTORY_LIMIT\)/);
  assert.match(apiSource, /\{ count: 'exact' \}/);
  assert.match(apiSource, /truncated:/);
});

test('desktop proxies history with the existing bearer authorization', () => {
  assert.match(serverSource, /app\.get \('\/api\/proxy\/runs'[\s\S]*proxyCloud\('GET',\s*'\/api\/runs'/);
  assert.match(screenSource, /getAccessToken\(\)/);
  assert.match(screenSource, /Authorization: `Bearer \$\{token\}`/);
  assert.match(screenSource, /fetch\('\/api\/proxy\/runs'/);
});

test('desktop history displays only already-sanitized cloud logs', () => {
  assert.match(apiSource, /raw_log_sanitized/);
  assert.match(screenSource, /Sanitized run summaries connected to your account/);
  assert.match(screenSource, /selected\.raw_log_sanitized/);
  assert.doesNotMatch(screenSource, /\/api\/logs\/history/);
});

test('run reports store the installed desktop version, not the legacy root package version', () => {
  const desktopLookup = reporterSource.indexOf("require('../desktop/package.json').version");
  const rootFallback = reporterSource.indexOf("require('../package.json').version");
  assert.ok(desktopLookup > -1 && rootFallback > desktopLookup);
});

test('sanitized cloud logs remove credentials, customer labels, emails, phones, and full paths', t => {
  const os = require('node:os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'statflobot-sanitize-'));
  const file = path.join(dir, 'run-test.log');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const lines = [
    { level: 'info', msg: 'client="Jane Doe" email jane@example.com phone (615) 555-1212' },
    { level: 'info', msg: 'unformatted phones 6155551212 and +16155551212' },
    { level: 'info', msg: '[DEBUG_VISIBLE_TEXT] preview="Maria Gonzalez 6155551212 4821 Oak Ridge Dr"' },
    { level: 'info', msg: '[DEBUG_COMPOSER_STATE] value="Hi Maria, your bill is due"' },
    { level: 'info', msg: '[DEBUG_CLICKABLE_SMS_LINES] lines=[{"label":"6155551212"}]' },
    { level: 'info', msg: 'saved /Users/jane/private/project/run.log' },
    { level: 'info', msg: 'Authorization: Bearer abcdefghijklmnopqrstuvwxyz' },
  ];
  fs.writeFileSync(file, lines.map(line => JSON.stringify(line)).join('\n'));
  const { sanitizeLog } = require('../src/run-reporter');
  const sanitized = sanitizeLog(file);
  assert.match(sanitized, /client="\[REDACTED\]"/);
  assert.match(sanitized, /\[REDACTED_EMAIL\]/);
  assert.match(sanitized, /\[REDACTED_PHONE\]/);
  assert.match(sanitized, /\[\.\.\.\/run\.log\]/);
  assert.doesNotMatch(sanitized, /Jane Doe|Maria Gonzalez|Oak Ridge|bill is due|jane@example\.com|615|Bearer|abcdefghijkl/);
  assert.doesNotMatch(statfloSource, /DEBUG_VISIBLE_TEXT[\s\S]*preview=/);
  assert.doesNotMatch(statfloSource, /SMS_LINE_DNC_DETECTED[^\n]*match=/);
  assert.doesNotMatch(statfloSource, /SMS_COOLDOWN_DETECTED[^\n]*match=/);
});

test('normal and fatal reporters prefer the refreshed local account proxy', async t => {
  const previousFetch = global.fetch;
  const previous = {
    port: process.env.RUFLO_DASHBOARD_PORT,
    reportToken: process.env.RUFLO_REPORT_TOKEN,
    cloudUrl: process.env.RUFLO_CLOUD_URL,
    accessToken: process.env.RUFLO_ACCESS_TOKEN,
  };
  t.after(() => {
    global.fetch = previousFetch;
    for (const [key, value] of Object.entries({
      RUFLO_DASHBOARD_PORT: previous.port,
      RUFLO_REPORT_TOKEN: previous.reportToken,
      RUFLO_CLOUD_URL: previous.cloudUrl,
      RUFLO_ACCESS_TOKEN: previous.accessToken,
    })) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });
  process.env.RUFLO_DASHBOARD_PORT = '3001';
  process.env.RUFLO_REPORT_TOKEN = 'test-report-token';
  process.env.RUFLO_CLOUD_URL = 'https://example.invalid';
  process.env.RUFLO_ACCESS_TOKEN = 'stale-spawn-token';
  const calls = [];
  global.fetch = async (url, options) => {
    calls.push({ url: String(url), options });
    return { ok: true, status: 200, text: async () => '', json: async () => ({ ok: true }) };
  };
  const { report } = require('../src/run-reporter');
  await report({ list: '1st Attempt', mode: 'live', messaged: 1, dnc: 0, skipped: 0, failed: 0 });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'http://127.0.0.1:3001/api/internal/run-report');
  assert.equal(calls[0].options.headers['X-Ruflo-Report-Token'], 'test-report-token');
  assert.equal(calls[0].options.headers.Authorization, undefined);
});

test('long runs refresh their cloud token and internal reports require a separate random token', () => {
  assert.match(appSource, /setInterval\(syncToken, 5 \* 60 \* 1000\)/);
  assert.match(appSource, /fetch\('\/api\/run\/session-token'/);
  assert.match(serverSource, /app\.post\('\/api\/run\/session-token', async/);
  assert.match(serverSource, /state\.lastRunToken = token/);
  assert.match(serverSource, /RUFLO_REPORT_TOKEN:\s+reportToken/);
  assert.match(serverSource, /app\.post\('\/api\/internal\/run-report', async/);
  assert.match(serverSource, /safeTokenEqual\(reportToken, state\.activeReportToken\)/);
});

test('stopped, fatal, and uncaught runs wait for account-history reporting', () => {
  assert.match(serverSource, /app\.post\('\/api\/stop', async/);
  assert.match(serverSource, /status: 'stopped'[\s\S]*await forwardRunReport/);
  assert.match(mainSource, /process\.on\('uncaughtException', async/);
  assert.match(mainSource, /await runReporter\.report[\s\S]*status: 'failed'/);
  assert.match(mainSource, /main\(\)\.catch\(async err =>/);
  assert.equal((mainSource.match(/await Promise\.allSettled/g) || []).length, 2);
  assert.match(mainSource, /let activeRunStats = null/);
  assert.match(mainSource, /runNextActionList\(page, runConfig, activeRunStats\)/);
  const stopStart = serverSource.indexOf("app.post('/api/stop'");
  const stopEnd = serverSource.indexOf("app.post('/api/continue'", stopStart);
  const stopRoute = serverSource.slice(stopStart, stopEnd);
  assert.ok(stopRoute.indexOf("io.emit('run:stopped'") < stopRoute.indexOf('await forwardRunReport'));
  assert.ok(stopRoute.indexOf('res.json({ ok: true })') < stopRoute.indexOf('await forwardRunReport'));
});

test('a selected historical run can prefill and attach to a support report', () => {
  assert.match(screenSource, /statflobot_support_history_run/);
  assert.match(screenSource, /attachHistoryRun=1/);
  assert.match(screenSource, /Send to support/);
  assert.match(supportSource, /SUPPORT_REPORT_HISTORY_RUN_ATTACHED/);
  assert.match(supportSource, /setLogContent\(summary\)/);
  assert.match(supportSource, /setSubject\(`StatfloBot run issue/);
});

test('cloud preserves bounded future run statuses instead of mislabeling them failed', () => {
  assert.match(apiSource, /function normalizeStatus/);
  assert.match(apiSource, /\? requested : 'recorded'/);
  assert.match(apiSource, /status:\s+normalizedStatus/);
  assert.doesNotMatch(apiSource, /RUN_STATUSES/);
  assert.match(serverSource, /\? requestedStatus : 'recorded'/);
  assert.match(screenSource, /STATUS\[run\.status\] \|\| STATUS\.recorded/);
});

test('a local reporting timeout cannot race a second direct cloud insert', () => {
  assert.match(reporterSource, /localErr\?\.name === 'AbortError'/);
});
