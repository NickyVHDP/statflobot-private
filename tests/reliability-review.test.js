'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const routeSource = fs.readFileSync(path.join(root, 'monetization/web/app/api/admin/reliability/route.ts'), 'utf8');
const classifierSource = fs.readFileSync(path.join(root, 'monetization/web/lib/reliability.ts'), 'utf8');
const serverSource = fs.readFileSync(path.join(root, 'ui/server/index.js'), 'utf8');
const panelSource = fs.readFileSync(path.join(root, 'ui/client/src/components/AdminPanel.jsx'), 'utf8');
const reviewSource = fs.readFileSync(path.join(root, 'ui/client/src/components/ReliabilityReview.jsx'), 'utf8');
const statfloSource = fs.readFileSync(path.join(root, 'src/statflo.js'), 'utf8');

test('fleet reliability endpoint requires an authenticated allowlisted owner', () => {
  assert.match(routeSource, /getAuthUser\(req\)/);
  assert.match(routeSource, /if \(!user\)[\s\S]*status: 401/);
  assert.match(routeSource, /if \(!isAdminEmail\(user\.email\)\)[\s\S]*status: 403/);
});

test('fleet query is failure-only, bounded, and limited to the retention period', () => {
  assert.match(routeSource, /const HISTORY_DAYS = 30/);
  assert.match(routeSource, /const HISTORY_LIMIT = 500/);
  assert.match(routeSource, /failed_count\.gt\.0,status\.in\.\(failed,error,completed_with_errors,browser_closed\)/);
  assert.match(routeSource, /\.gte\('created_at', cutoff\)/);
  assert.match(routeSource, /\.limit\(HISTORY_LIMIT\)/);
  assert.match(routeSource, /filter\(isReportableFailure\)/);
});

test('admin reliability response omits customer identity and billing fields', () => {
  const projection = routeSource.match(/const projection = '([^']+)'/)?.[1] || '';
  assert.ok(projection, 'expected an explicit database projection');
  for (const forbidden of ['user_id', 'email', 'full_name', 'license', 'subscription', 'phone']) {
    assert.doesNotMatch(projection, new RegExp(forbidden, 'i'));
  }
  assert.match(routeSource, /customer identities omitted/);
});

test('classifier keeps DNC, cooldown-adjacent line failures, and identity safety distinct', () => {
  assert.match(classifierSource, /category: 'dnc_workflow'[\s\S]*DNC_MENU_NOT_FOUND/);
  assert.match(classifierSource, /category: 'line_navigation'[\s\S]*SMS_LINE_INCOMPLETE_NO_DNC/);
  assert.match(classifierSource, /category: 'identity_safety'[\s\S]*STATFLO_IDENTITY_MISMATCH_BLOCKED/);
  assert.doesNotMatch(classifierSource, /category: 'dnc_workflow'[\s\S]{0,300}cooldown/i);
});

test('desktop exposes the review only through the admin panel and cloud proxy', () => {
  assert.match(serverSource, /\/api\/proxy\/admin\/reliability[\s\S]*\/api\/admin\/reliability/);
  assert.match(panelSource, /import ReliabilityReview/);
  assert.match(panelSource, /<ReliabilityReview onLoaded=\{onReliabilityLoaded\} refreshToken=\{refreshToken\} \/>/);
  assert.match(reviewSource, /Owner only/);
  assert.match(reviewSource, /Customer identities and message content are omitted/);
});

test('repair bundle is bounded to sanitized server response data', () => {
  assert.match(reviewSource, /function exportBundle/);
  assert.match(reviewSource, /payload\.runs/);
  assert.doesNotMatch(reviewSource, /user_id|full_name|customer_email|phone_number/i);
});

test('runtime still tries the next phone line and refuses unsafe DNC writes', () => {
  assert.match(statfloSource, /SMS_LINE_TRY_NEXT/);
  assert.match(statfloSource, /SMS_LINE_INCOMPLETE_NO_DNC/);
  assert.match(statfloSource, /SMS_LINE_COOLDOWN_SKIP_NO_DNC/);
  assert.match(statfloSource, /SMS_LINE_UNCERTAIN_SKIP_NO_DNC/);
  assert.match(statfloSource, /CLIENT_SKIPPED_SEND_STATE_UNCERTAIN_NO_DNC/);
  assert.match(statfloSource, /SMS_LINE_DNC_ALLOWED/);
  assert.match(statfloSource, /enteredKeys\.size < initialTotalLines \|\| lineIdentityAmbiguous/);
  const uncertainGuard = statfloSource.indexOf('if (uncertainBlockedCount > 0)');
  const dncPermission = statfloSource.indexOf("logger.info(`[SMS_LINE_DNC_ALLOWED]", uncertainGuard);
  assert.ok(uncertainGuard > -1 && dncPermission > uncertainGuard, 'uncertain Send state must be refused before DNC permission');
});
