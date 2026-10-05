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

test('fleet run activity is bounded and limited to the retention period', () => {
  assert.match(routeSource, /const HISTORY_DAYS = 30/);
  assert.match(routeSource, /const HISTORY_LIMIT = 500/);
  assert.match(routeSource, /\.gte\('created_at', cutoff\)/);
  assert.match(routeSource, /\.limit\(HISTORY_LIMIT\)/);
  assert.match(routeSource, /reportableFailure = isReportableFailure\(run\)/);
});

test('owner run activity resolves account identity but strips internal ids and customer data', () => {
  const projection = routeSource.match(/const projection = '([^']+)'/)?.[1] || '';
  assert.ok(projection, 'expected an explicit database projection');
  assert.match(projection, /user_id/);
  for (const forbidden of ['email', 'full_name', 'license', 'subscription', 'phone']) {
    assert.doesNotMatch(projection, new RegExp(forbidden, 'i'));
  }
  assert.match(routeSource, /from\('profiles'\).*select\('id, email, full_name'\)/s);
  assert.match(routeSource, /from\('licenses'\)[\s\S]*statflo_identity_raw/);
  assert.match(routeSource, /lockedUsername/);
  assert.match(routeSource, /const \{ user_id: _userId/);
  assert.match(routeSource, /actorEmail/);
  assert.match(routeSource, /Statflo customer identities and message content omitted/);
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
  assert.match(reviewSource, /Statflo customer names and message content remain private/);
  assert.match(reviewSource, /run\.lockedUsername \|\| run\.actorName \|\| run\.actorEmail/);
});

test('repair bundle is bounded to sanitized server response data', () => {
  assert.match(reviewSource, /function exportBundle/);
  assert.match(reviewSource, /payload\.runs/);
  assert.doesNotMatch(reviewSource, /user_id|customer_email|phone_number/i);
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

test('owner review distinguishes all-skipped runs and shows the reason breakdown', () => {
  assert.match(routeSource, /const allSkipped = run\.sent_count === 0 && run\.skipped_count > 0/);
  assert.match(routeSource, /needsReviewCount/);
  assert.match(reviewSource, /Skip breakdown/);
  assert.match(reviewSource, /run\.needsReview/);
});
