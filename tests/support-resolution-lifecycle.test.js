const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), 'utf8');

const migration = read('supabase', 'migrations', '20260810190000_support_reports.sql');
const reportRoute = read('monetization', 'web', 'app', 'api', 'support', 'report', 'route.ts');
const noticesRoute = read('monetization', 'web', 'app', 'api', 'support', 'notices', 'route.ts');
const ackRoute = read('monetization', 'web', 'app', 'api', 'support', 'notices', 'ack', 'route.ts');
const adminList = read('monetization', 'web', 'app', 'api', 'admin', 'support', 'reports', 'route.ts');
const resolveRoute = read('monetization', 'web', 'app', 'api', 'admin', 'support', 'resolve', 'route.ts');
const helpers = read('monetization', 'web', 'lib', 'supportReports.ts');
const email = read('monetization', 'web', 'lib', 'supportEmail.ts');
const localServer = read('ui', 'server', 'index.js');
const app = read('ui', 'client', 'src', 'App.jsx');
const modal = read('ui', 'client', 'src', 'components', 'SupportResolutionModal.jsx');

test('support tickets store metadata but never diagnostic log bodies', () => {
  assert.doesNotMatch(migration, /raw_log|log_content|diagnostic_body/i);
  assert.match(migration, /log_attached/);
  assert.match(migration, /revoke all on table public\.support_reports from authenticated/);
  assert.match(migration, /no policy for anon\/authenticated/i);
});

test('customer notice routes derive ownership only from the verified session', () => {
  assert.match(noticesRoute, /getAuthUser\(req\)/);
  assert.match(noticesRoute, /\.eq\('user_id', user\.id\)/);
  assert.match(noticesRoute, /CUSTOMER_NOTICE_COLUMNS/);
  assert.doesNotMatch(noticesRoute, /select\('\*'\)/);
  assert.match(ackRoute, /\.eq\('user_id', user\.id\)/);
  assert.match(ackRoute, /\.eq\('reference', reference\)/);
});

test('owner routes require server-verified admin access', () => {
  for (const source of [adminList, resolveRoute]) {
    assert.match(source, /getAuthUser\(req\)/);
    assert.match(source, /isAdminEmail\(/);
    assert.match(source, /Admin access required/);
  }
});

test('resolution is blocked until its app version is confirmed public', () => {
  assert.match(resolveRoute, /getPublicAppVersion\(\)/);
  assert.match(resolveRoute, /compareVersions\(publicVersion, fixedInVersion\)/);
  assert.match(resolveRoute, /reason: 'fix-not-public'/);
  assert.ok(resolveRoute.indexOf("reason: 'fix-not-public'") < resolveRoute.indexOf("status: 'resolved'"));
});

test('customer email cannot send from development or tests', () => {
  assert.match(email, /process\.env\.NODE_ENV !== 'production'/);
  assert.match(email, /return 'dry-run'/);
  assert.match(resolveRoute, /customerEmailMode\(\) !== 'live'/);
});

test('resolution email is account-owned, idempotent, and concurrency claimed', () => {
  assert.match(resolveRoute, /auth\.admin\.getUserById\(existing\.user_id\)/);
  assert.match(resolveRoute, /email_confirmed_at/);
  assert.doesNotMatch(resolveRoute, /to:\s*existing\.contact_email/);
  assert.match(resolveRoute, /idempotencyKey: `support-resolution-\$\{existing\.id\}`/);
  assert.match(resolveRoute, /\.eq\('resolution_email_status', existing\.resolution_email_status\)/);
  assert.match(resolveRoute, /\.eq\('resolution_email_attempted_at', existing\.resolution_email_attempted_at\)/);
  assert.match(resolveRoute, /duplicate: true/);
});

test('submission retries use one UUID and return a customer reference', () => {
  const supportScreen = read('ui', 'client', 'src', 'screens', 'SupportScreen.jsx');
  assert.match(supportScreen, /crypto\.randomUUID\(\)/);
  assert.match(supportScreen, /submissionId,/);
  assert.match(reportRoute, /\.eq\('submission_id', submissionId\)/);
  assert.match(reportRoute, /duplicateSubmission: true/);
  assert.match(localServer, /reportReference/);
});

test('startup modal priority is welcome, private resolution, then release notes', () => {
  assert.match(app, /Welcome → private resolution notice → What's New/);
  assert.match(app, /activeSupportNotice && !showWelcome && !showSubGate && !showCompletion/);
  assert.match(app, /whatsNewRelease && !showWelcome && !activeSupportNotice/);
  assert.match(modal, /fixDelivery === 'update-available'/);
  assert.match(modal, /Update Now/);
  assert.match(modal, /onAcknowledge\(notice\.reference\)/);
  assert.ok(modal.indexOf('if (update) await onUpdate()') < modal.indexOf('await onAcknowledge(notice.reference)'));
});

// Strips comments, so the claim guards below read copy rather than prose: the
// modules explain this rule in their own comments, and a comment naming a
// forbidden phrase is not the app saying it to a customer.
const codeOnly = (source) => source
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n')
  .filter((line) => !line.trim().startsWith('//'))
  .join('\n');

// Language that would promise a per-customer build. Nothing in the product can
// deliver one — there is a single public release channel — so this phrasing
// would be a promise the updater cannot keep.
const PRIVATE_BUILD_CLAIMS = [
  /custom build/i,
  /private build/i,
  /private version/i,
  /your own (?:build|version|copy)/i,
  /built (?:just )?for you/i,
  /this update is private/i,
];

test('the resolution popup separates the private report from the public fix', () => {
  // The private thing is the notice and the report behind it.
  assert.match(modal, /This notice and your report are private to your\s+account/);
  assert.match(modal, /Private support notice/);
  // The fix is not private, and the popup says so in the same breath.
  assert.match(modal, /the fix itself ships to every StatfloBot user in the public update/);
  assert.match(modal, /Fix included in the public update/);
  for (const claim of PRIVATE_BUILD_CLAIMS) assert.doesNotMatch(codeOnly(modal), claim);

  // The specifics the customer actually needs survive the rewording.
  assert.match(modal, /\{notice\.resolutionMessage\}/);
  assert.match(modal, /\{notice\.reference\}/);
  assert.match(modal, /v\{notice\.fixedInVersion\}/);
});

test('the popup only claims a public release once one is downloadable', () => {
  // toCustomerNotice() nulls fixedInVersion while a fix is unreleased, so both
  // the "available to everyone" line and the version row must key off it.
  assert.match(modal, /const fixIsPublic = Boolean\(notice\?\.fixedInVersion\)/);
  assert.match(modal, /fixIsPublic\s*\n?\s*\? ' — the fix itself ships to every StatfloBot user/);
  assert.match(modal, /\{fixIsPublic && \(/);
  assert.match(helpers, /fixDelivery === 'pending-release' \? null : row\.fixed_in_version/);
});

test('the resolution email carries the same public/private distinction', () => {
  assert.match(email, /the public release available to every StatfloBot user/);
  assert.match(email, /an upcoming public StatfloBot update/);
  assert.match(email, /This notice and your report are private to your account/);
  for (const claim of PRIVATE_BUILD_CLAIMS) assert.doesNotMatch(codeOnly(email), claim);

  // The "everyone gets it" wording stays behind the same release gate as before.
  assert.match(email, /fixReleased && fixedInVersion/);
  assert.match(email, /StatfloBot v\$\{escapeHtml\(fixedInVersion\)\}/);
  assert.match(email, /escapeHtml\(resolutionMessage\)/);
});

test('customer projections cannot expose logs, provider data, or admin identity', () => {
  const projection = helpers.match(/CUSTOMER_NOTICE_COLUMNS\s*=\s*\n?\s*'([^']+)'/)?.[1] ?? '';
  assert.ok(projection.includes('reference'));
  assert.ok(projection.includes('resolution_message'));
  for (const forbidden of ['log_', 'provider', 'resolved_by', 'description', 'contact_email', 'bot_run_id']) {
    assert.ok(!projection.includes(forbidden), `customer projection must omit ${forbidden}`);
  }
});
