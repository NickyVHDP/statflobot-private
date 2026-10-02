'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), 'utf8');

const policy = read('monetization', 'web', 'lib', 'dashboardRetention.ts');
const adminRoute = read('monetization', 'web', 'app', 'api', 'admin', 'retention', 'route.ts');
const cronRoute = read('monetization', 'web', 'app', 'api', 'cron', 'dashboard-retention', 'route.ts');
const vercel = JSON.parse(read('monetization', 'web', 'vercel.json'));
const server = read('ui', 'server', 'index.js');
const review = read('ui', 'client', 'src', 'components', 'ReliabilityReview.jsx');
const manager = read('desktop', 'electron', 'server-manager.js');

test('dashboard retention deletes only expired run history and resolved support reports', () => {
  assert.match(policy, /DASHBOARD_RETENTION_DAYS = 30/);
  assert.match(policy, /from\('bot_runs'\)[\s\S]*\.delete\(\)[\s\S]*\.lt\('created_at', cutoff\)/);
  assert.match(policy, /from\('support_reports'\)[\s\S]*\.delete\(\)[\s\S]*\.lt\('created_at', cutoff\)[\s\S]*\.in\('status', \['resolved', 'closed'\]\)/);
  assert.doesNotMatch(policy, /\.from\('(referral|payout|subscription|payment)/i);
});

test('cleanup is automatic behind the cron secret and manually owner-gated', () => {
  assert.match(cronRoute, /CRON_SECRET/);
  assert.match(cronRoute, /timingSafeEqual/);
  assert.match(adminRoute, /getAuthUser\(req\)/);
  assert.match(adminRoute, /isAdminEmail\(user\.email\)/);
  assert.ok(vercel.crons.some(item => item.path === '/api/cron/dashboard-retention'));
  assert.match(server, /\/api\/proxy\/admin\/retention[\s\S]*\/api\/admin\/retention/);
  assert.match(review, /Clean 30\+ days/);
  assert.match(review, /cleanExpiredDashboardHistory/);
});

test('the packaged runtime version comes directly from Electron app.getVersion', () => {
  assert.match(manager, /const runtimeAppVersion = app\.getVersion\(\)/);
  assert.match(manager, /STATFLOBOT_APP_VERSION:\s+runtimeAppVersion/);
  assert.doesNotMatch(manager, /_desktopVersion/);
});
