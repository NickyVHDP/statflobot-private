const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const localServer = fs.readFileSync(path.join(root, 'ui', 'server', 'index.js'), 'utf8');
const cloudRoute = fs.readFileSync(
  path.join(root, 'monetization', 'web', 'app', 'api', 'support', 'report', 'route.ts'),
  'utf8',
);

test('desktop support reports can carry a full failed-run log as JSON', () => {
  assert.match(localServer, /express\.json\(\{ limit: '25mb' \}\)/);
  assert.match(localServer, /resolveLatestFailedLog\(\)/);
  assert.match(localServer, /historyRunId/);
  assert.match(localServer, /latest failed logs unavailable/);
  assert.match(localServer, /logIncluded:\s*log\.available/);
});

test('historical logs are resolved server-side and scoped to the authenticated user', () => {
  assert.match(cloudRoute, /historyRunId/);
  assert.match(cloudRoute, /\.eq\('id', historyRunId\)/);
  assert.match(cloudRoute, /\.eq\('user_id', user\.id\)/);
  assert.match(cloudRoute, /historyLog \|\|/);
});

test('desktop only claims delivery after the cloud confirms emailSent', () => {
  const routeStart = localServer.indexOf("app.post('/api/support/report'");
  const routeEnd = localServer.indexOf('\n});', routeStart) + 4;
  const route = localServer.slice(routeStart, routeEnd);

  assert.match(route, /upstream\.ok && body\.emailSent/);
  assert.match(route, /status\(502\)\.json\(\{/);
  assert.match(route, /emailSent:\s*false/);
  assert.match(route, /emailSent:\s*true/);
});

test('cloud support route returns JSON and rejects provider failures', () => {
  assert.match(cloudRoute, /const providerRes = await fetch\('https:\/\/api\.resend\.com\/emails'/);
  assert.match(cloudRoute, /if \(!providerRes\.ok\)/);
  assert.match(cloudRoute, /\{ status: 502 \}/);
  assert.match(cloudRoute, /NextResponse\.json\(\{/);
  assert.match(cloudRoute, /emailSent: true/);
  assert.match(cloudRoute, /logIncluded: logAvailable/);

  assert.ok(
    cloudRoute.indexOf('if (!providerRes.ok)') < cloudRoute.indexOf('emailSent: true'),
    'success must be returned only after provider acceptance is checked',
  );
});
